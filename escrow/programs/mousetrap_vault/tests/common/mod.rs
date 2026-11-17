#![allow(dead_code)]

use {
    anchor_lang::{
        compat::solana_instructions_sysvar,
        prelude::{Clock, Pubkey},
        solana_program::{
            instruction::{AccountMeta, Instruction},
            program_pack::Pack,
            system_instruction, system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{self, get_associated_token_address},
        token::{self, spl_token},
    },
    litesvm::LiteSVM,
    mousetrap_vault::{
        accounts as acc, instruction as ix, VaultConfig, VaultParams, VaultSettings, VaultState,
        AUTHORITY_SEED, BOND_SEED, CONFIG_SEED, DEPOSIT_SEED, ED25519_PROGRAM_ID, EPOCH_SEED,
        IDLE_SEED, SHARE_MINT_SEED, STATE_SEED, WITHDRAW_SEED,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub const START: i64 = 1_800_000_000;

pub fn usdc(whole: u64) -> u64 {
    whole * 1_000_000
}

pub fn test_params() -> VaultParams {
    VaultParams {
        bond_min_bps: 1_500,
        absolute_cap: usdc(100_000),
        drawn_nav_max_bps: 6_000,
        buffer_bps: 2_000,
        health_min_bps: 9_700,
        recall_health_bps: 9_000,
        per_draw_bps: 2_500,
        nav_max_age_secs: 3_600,
        nav_silence_secs: 86_400,
        recall_deadline_secs: 172_800,
        epoch_min_secs: 3_600,
        performance_fee_bps: 2_000,
        deposit_cap: 0,
    }
}

pub struct Pdas {
    pub config: Pubkey,
    pub state: Pubkey,
    pub authority: Pubkey,
    pub idle: Pubkey,
    pub bond: Pubkey,
    pub share_mint: Pubkey,
}

impl Pdas {
    fn new() -> Self {
        let p = |seed: &[u8]| Pubkey::find_program_address(&[seed], &mousetrap_vault::id()).0;
        Pdas {
            config: p(CONFIG_SEED),
            state: p(STATE_SEED),
            authority: p(AUTHORITY_SEED),
            idle: p(IDLE_SEED),
            bond: p(BOND_SEED),
            share_mint: p(SHARE_MINT_SEED),
        }
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub owner: Keypair,
    pub sentinel: Keypair,
    pub operator: Keypair,
    pub fee_recipient: Keypair,
    pub attestors: Vec<Keypair>,
    pub usdc_mint: Keypair,
    /// Stands in for the operator's Gemini account.
    pub gemini: Keypair,
    pub gemini_usdc: Pubkey,
    pub operator_usdc: Pubkey,
    pub pda: Pdas,
}

impl Env {
    /// A vault initialised with `test_params`, a 2-of-3 attestor set and a funded operator.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/mousetrap_vault.so"));
        svm.add_program(mousetrap_vault::id(), bytes).unwrap();

        let mut env = Env {
            svm,
            owner: Keypair::new(),
            sentinel: Keypair::new(),
            operator: Keypair::new(),
            fee_recipient: Keypair::new(),
            attestors: (0..3).map(|_| Keypair::new()).collect(),
            usdc_mint: Keypair::new(),
            gemini: Keypair::new(),
            gemini_usdc: Pubkey::default(),
            operator_usdc: Pubkey::default(),
            pda: Pdas::new(),
        };
        env.set_time(START);
        for k in [&env.owner, &env.sentinel, &env.operator, &env.gemini] {
            env.svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        env.create_mint();
        env.gemini_usdc = env.token_account(&env.gemini.pubkey());
        env.operator_usdc = env.token_account(&env.operator.pubkey());
        env.mint_to(&env.operator_usdc.clone(), usdc(50_000));

        let settings = env.settings();
        let (ix, owner) = (env.initialize_ix(settings), env.owner.insecure_clone());
        env.send_ok(&[ix], &[&owner]);
        env
    }

    pub fn settings(&self) -> VaultSettings {
        let mut attestors = [Pubkey::default(); 5];
        for (i, a) in self.attestors.iter().enumerate() {
            attestors[i] = a.pubkey();
        }
        VaultSettings {
            params: test_params(),
            sentinel: self.sentinel.pubkey(),
            operator: self.operator.pubkey(),
            fee_recipient: self.fee_recipient.pubkey(),
            gemini_destination: self.gemini_usdc,
            attestors,
            attestor_count: 3,
            quorum: 2,
        }
    }

    // --- chain plumbing ---

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn set_time(&mut self, t: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = t;
        self.svm.set_sysvar(&clock);
    }

    pub fn warp(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.set_time(t);
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    pub fn send_ok(&mut self, ixs: &[Instruction], signers: &[&Keypair]) {
        if let Err(e) = self.send(ixs, signers) {
            panic!("transaction failed: {e}");
        }
    }

    /// Asserts the transaction fails with the given program error.
    pub fn send_err(&mut self, ixs: &[Instruction], signers: &[&Keypair], code: u32) {
        match self.send(ixs, signers) {
            Ok(()) => panic!("expected error {code}, transaction succeeded"),
            Err(e) => assert!(e.contains(&format!("Custom({code})")), "expected error {code}, got: {e}"),
        }
    }

    fn create_mint(&mut self) {
        let rent = self.svm.minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN);
        let ixs = [
            system_instruction::create_account(
                &self.owner.pubkey(),
                &self.usdc_mint.pubkey(),
                rent,
                spl_token::state::Mint::LEN as u64,
                &token::ID,
            ),
            spl_token::instruction::initialize_mint2(&token::ID, &self.usdc_mint.pubkey(), &self.owner.pubkey(), None, 6)
                .unwrap(),
        ];
        let (owner, mint) = (self.owner.insecure_clone(), self.usdc_mint.insecure_clone());
        self.send_ok(&ixs, &[&owner, &mint]);
    }

    /// A fresh USDC token account owned by `owner`.
    pub fn token_account(&mut self, owner: &Pubkey) -> Pubkey {
        let account = Keypair::new();
        let rent = self.svm.minimum_balance_for_rent_exemption(spl_token::state::Account::LEN);
        let ixs = [
            system_instruction::create_account(
                &self.owner.pubkey(),
                &account.pubkey(),
                rent,
                spl_token::state::Account::LEN as u64,
                &token::ID,
            ),
            spl_token::instruction::initialize_account3(&token::ID, &account.pubkey(), &self.usdc_mint.pubkey(), owner)
                .unwrap(),
        ];
        let owner = self.owner.insecure_clone();
        self.send_ok(&ixs, &[&owner, &account]);
        account.pubkey()
    }

    pub fn mint_to(&mut self, to: &Pubkey, amount: u64) {
        let ix = spl_token::instruction::mint_to(&token::ID, &self.usdc_mint.pubkey(), to, &self.owner.pubkey(), &[], amount)
            .unwrap();
        let owner = self.owner.insecure_clone();
        self.send_ok(&[ix], &[&owner]);
    }

    /// A funded staker with a USDC account.
    pub fn staker(&mut self, amount: u64) -> (Keypair, Pubkey) {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let account = self.token_account(&kp.pubkey());
        self.mint_to(&account, amount);
        (kp, account)
    }

    pub fn balance(&self, account: &Pubkey) -> u64 {
        match self.svm.get_account(account) {
            Some(a) if !a.data.is_empty() => spl_token::state::Account::unpack(&a.data).unwrap().amount,
            _ => 0,
        }
    }

    pub fn shares_of(&self, owner: &Pubkey) -> u64 {
        self.balance(&get_associated_token_address(owner, &self.pda.share_mint))
    }

    pub fn state(&self) -> VaultState {
        let account = self.svm.get_account(&self.pda.state).unwrap();
        VaultState::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn config(&self) -> VaultConfig {
        let account = self.svm.get_account(&self.pda.config).unwrap();
        VaultConfig::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    // --- instruction builders ---

    fn ix(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
        Instruction::new_with_bytes(mousetrap_vault::id(), &data, accounts)
    }

    pub fn initialize_ix(&self, settings: VaultSettings) -> Instruction {
        Self::ix(
            ix::Initialize { settings }.data(),
            acc::Initialize {
                owner: self.owner.pubkey(),
                config: self.pda.config,
                state: self.pda.state,
                authority: self.pda.authority,
                usdc_mint: self.usdc_mint.pubkey(),
                share_mint: self.pda.share_mint,
                idle_vault: self.pda.idle,
                bond_vault: self.pda.bond,
                gemini_destination: settings.gemini_destination,
                token_program: token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn sentinel_ix(&self, signer: &Pubkey, data: Vec<u8>) -> Instruction {
        Self::ix(
            data,
            acc::Sentinel { sentinel: *signer, config: self.pda.config, state: self.pda.state }.to_account_metas(None),
        )
    }

    pub fn deposit_ix(&self, owner: &Pubkey, owner_usdc: &Pubkey, amount: u64) -> Instruction {
        Self::ix(
            ix::Deposit { amount }.data(),
            acc::Deposit {
                owner: *owner,
                config: self.pda.config,
                state: self.pda.state,
                idle_vault: self.pda.idle,
                owner_usdc: *owner_usdc,
                ticket: self.ticket(DEPOSIT_SEED, owner, self.state().epoch),
                token_program: token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn claim_deposit_ix(&self, owner: &Pubkey, epoch: u64) -> Instruction {
        Self::ix(
            ix::ClaimDeposit {}.data(),
            acc::ClaimDeposit {
                owner: *owner,
                config: self.pda.config,
                state: self.pda.state,
                ticket: self.ticket(DEPOSIT_SEED, owner, epoch),
                epoch_record: self.epoch_record(epoch),
                share_mint: self.pda.share_mint,
                owner_shares: get_associated_token_address(owner, &self.pda.share_mint),
                authority: self.pda.authority,
                token_program: token::ID,
                associated_token_program: associated_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn request_withdraw_ix(&self, owner: &Pubkey, shares: u64) -> Instruction {
        Self::ix(
            ix::RequestWithdraw { shares }.data(),
            acc::RequestWithdraw {
                owner: *owner,
                config: self.pda.config,
                state: self.pda.state,
                share_mint: self.pda.share_mint,
                owner_shares: get_associated_token_address(owner, &self.pda.share_mint),
                ticket: self.ticket(WITHDRAW_SEED, owner, self.state().epoch),
                token_program: token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn claim_withdraw_ix(&self, owner: &Pubkey, owner_usdc: &Pubkey, epoch: u64) -> Instruction {
        Self::ix(
            ix::ClaimWithdraw {}.data(),
            acc::ClaimWithdraw {
                owner: *owner,
                config: self.pda.config,
                state: self.pda.state,
                ticket: self.ticket(WITHDRAW_SEED, owner, epoch),
                epoch_record: self.epoch_record(epoch),
                idle_vault: self.pda.idle,
                owner_usdc: *owner_usdc,
                authority: self.pda.authority,
                token_program: token::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn post_bond_ix(&self, payer: &Pubkey, payer_usdc: &Pubkey, amount: u64) -> Instruction {
        Self::ix(
            ix::PostBond { amount }.data(),
            acc::PostBond {
                payer: *payer,
                config: self.pda.config,
                bond_vault: self.pda.bond,
                payer_usdc: *payer_usdc,
                token_program: token::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn release_bond_ix(&self, amount: u64) -> Instruction {
        Self::ix(
            ix::ReleaseBond { amount }.data(),
            acc::ReleaseBond {
                operator: self.operator.pubkey(),
                config: self.pda.config,
                state: self.pda.state,
                bond_vault: self.pda.bond,
                operator_usdc: self.operator_usdc,
                authority: self.pda.authority,
                token_program: token::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn draw_ix_to(&self, signer: &Pubkey, destination: &Pubkey, amount: u64) -> Instruction {
        Self::ix(
            ix::RequestDraw { amount, categories: 1 }.data(),
            acc::RequestDraw {
                operator: *signer,
                config: self.pda.config,
                state: self.pda.state,
                idle_vault: self.pda.idle,
                bond_vault: self.pda.bond,
                gemini_destination: *destination,
                authority: self.pda.authority,
                token_program: token::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn draw_ix(&self, amount: u64) -> Instruction {
        self.draw_ix_to(&self.operator.pubkey(), &self.gemini_usdc, amount)
    }

    fn return_accounts(&self, payer: &Pubkey, payer_usdc: &Pubkey) -> Vec<AccountMeta> {
        acc::ReturnFunds {
            payer: *payer,
            config: self.pda.config,
            state: self.pda.state,
            idle_vault: self.pda.idle,
            payer_usdc: *payer_usdc,
            token_program: token::ID,
        }
        .to_account_metas(None)
    }

    /// Repayment from the Gemini account, as the relayer would send it.
    pub fn repay_ix(&self, amount: u64) -> Instruction {
        Self::ix(ix::Repay { amount }.data(), self.return_accounts(&self.gemini.pubkey(), &self.gemini_usdc))
    }

    pub fn sweep_ix(&self, amount: u64) -> Instruction {
        Self::ix(ix::SweepProfit { amount }.data(), self.return_accounts(&self.gemini.pubkey(), &self.gemini_usdc))
    }

    pub fn submit_nav_ix(&self, submitter: &Pubkey, report: mousetrap_vault::NavReport) -> Instruction {
        Self::ix(
            ix::SubmitNav { report }.data(),
            acc::SubmitNav {
                submitter: *submitter,
                config: self.pda.config,
                state: self.pda.state,
                idle_vault: self.pda.idle,
                bond_vault: self.pda.bond,
                authority: self.pda.authority,
                instructions: solana_instructions_sysvar::ID,
                token_program: token::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn check_nav_silence_ix(&self) -> Instruction {
        Self::ix(
            ix::CheckNavSilence {}.data(),
            acc::CheckNavSilence { config: self.pda.config, state: self.pda.state }.to_account_metas(None),
        )
    }

    pub fn slash_bond_ix(&self) -> Instruction {
        Self::ix(
            ix::SlashBond {}.data(),
            acc::SlashBond {
                config: self.pda.config,
                state: self.pda.state,
                idle_vault: self.pda.idle,
                bond_vault: self.pda.bond,
                authority: self.pda.authority,
                token_program: token::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn settle_ix(&self, payer: &Pubkey) -> Instruction {
        Self::ix(
            ix::SettleEpoch {}.data(),
            acc::SettleEpoch {
                payer: *payer,
                config: self.pda.config,
                state: self.pda.state,
                idle_vault: self.pda.idle,
                epoch_record: self.epoch_record(self.state().epoch),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn claim_fees_ix(&self, payer: &Pubkey) -> Instruction {
        Self::ix(
            ix::ClaimFees {}.data(),
            acc::ClaimFees {
                payer: *payer,
                config: self.pda.config,
                state: self.pda.state,
                share_mint: self.pda.share_mint,
                fee_recipient: self.fee_recipient.pubkey(),
                fee_shares: get_associated_token_address(&self.fee_recipient.pubkey(), &self.pda.share_mint),
                authority: self.pda.authority,
                token_program: token::ID,
                associated_token_program: associated_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ticket(&self, seed: &[u8], owner: &Pubkey, epoch: u64) -> Pubkey {
        Pubkey::find_program_address(&[seed, owner.as_ref(), &epoch.to_le_bytes()], &mousetrap_vault::id()).0
    }

    pub fn epoch_record(&self, epoch: u64) -> Pubkey {
        Pubkey::find_program_address(&[EPOCH_SEED, &epoch.to_le_bytes()], &mousetrap_vault::id()).0
    }

    // --- attestation ---

    pub fn report(&self, equity: u64) -> mousetrap_vault::NavReport {
        mousetrap_vault::NavReport { equity, positions_hash: [7; 32], rebate_total: 0, timestamp: self.now() }
    }

    /// Submit-NAV transaction signed by the given attestor keys.
    pub fn nav_ixs(&self, report: mousetrap_vault::NavReport, signers: &[&Keypair]) -> Vec<Instruction> {
        let message = mousetrap_vault::attest::nav_message(&self.pda.state, &report);
        let mut ixs: Vec<Instruction> = signers.iter().map(|k| ed25519_ix(k, &message)).collect();
        ixs.push(self.submit_nav_ix(&self.operator.pubkey(), report));
        ixs
    }

    /// Posts a NAV report signed by two of the three attestors.
    pub fn post_nav(&mut self, equity: u64) {
        let report = self.report(equity);
        let ixs = self.nav_ixs(report, &[&self.attestors[0], &self.attestors[1]]);
        let operator = self.operator.insecure_clone();
        self.send_ok(&ixs, &[&operator]);
    }

    pub fn settle(&mut self) {
        let ix = self.settle_ix(&self.operator.pubkey());
        let operator = self.operator.insecure_clone();
        self.send_ok(&[ix], &[&operator]);
    }

    pub fn post_bond(&mut self, amount: u64) {
        let ix = self.post_bond_ix(&self.operator.pubkey(), &self.operator_usdc, amount);
        let operator = self.operator.insecure_clone();
        self.send_ok(&[ix], &[&operator]);
    }

    /// A staker deposits, the epoch settles, and the staker claims shares.
    pub fn onboard(&mut self, amount: u64) -> (Keypair, Pubkey) {
        let (staker, staker_usdc) = self.staker(amount);
        let epoch = self.state().epoch;
        let ix = self.deposit_ix(&staker.pubkey(), &staker_usdc, amount);
        self.send_ok(&[ix], &[&staker]);
        self.warp(3_601);
        self.settle();
        let ix = self.claim_deposit_ix(&staker.pubkey(), epoch);
        self.send_ok(&[ix], &[&staker]);
        (staker, staker_usdc)
    }

    pub fn draw(&mut self, amount: u64) -> Result<(), String> {
        let ix = self.draw_ix(amount);
        let operator = self.operator.insecure_clone();
        self.send(&[ix], &[&operator])
    }

    pub fn gemini_send(&mut self, ix: Instruction) {
        let gemini = self.gemini.insecure_clone();
        self.send_ok(&[ix], &[&gemini]);
    }
}

/// One ed25519 precompile instruction carrying a single signature, with key,
/// signature and message all inline.
pub fn ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
    const HEADER: u16 = 2 + 14;
    let pk_offset = HEADER;
    let sig_offset = pk_offset + 32;
    let msg_offset = sig_offset + 64;
    let signature = signer.sign_message(message);

    let mut data = vec![1u8, 0];
    for v in [sig_offset, u16::MAX, pk_offset, u16::MAX, msg_offset, message.len() as u16, u16::MAX] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    data.extend_from_slice(&signer.pubkey().to_bytes());
    data.extend_from_slice(signature.as_ref());
    data.extend_from_slice(message);
    Instruction { program_id: ED25519_PROGRAM_ID, accounts: vec![], data }
}

pub fn err(e: mousetrap_vault::error::VaultError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}
