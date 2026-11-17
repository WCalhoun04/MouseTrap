/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/mousetrap_vault.json`.
 */
export type MousetrapVault = {
  "address": "2rhxbbbqDtRPfGDAcd4LK7iqbR6Ro58R3QLs1NG9EZfd",
  "metadata": {
    "name": "mousetrapVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "MouseTrap maker-rebate vault: escrow, draw gate, attested NAV"
  },
  "docs": [
    "Maker-rebate vault escrow. See AGENTS.md sections 4 and 5."
  ],
  "instructions": [
    {
      "name": "checkNavSilence",
      "discriminator": [
        166,
        117,
        244,
        238,
        202,
        124,
        133,
        22
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "claimDeposit",
      "discriminator": [
        201,
        106,
        1,
        224,
        122,
        144,
        210,
        155
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "ticket"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "writable": true
        },
        {
          "name": "epochRecord",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  112,
                  111,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "ticket.epoch",
                "account": "depositTicket"
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true
        },
        {
          "name": "ownerShares",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "shareMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "claimFees",
      "discriminator": [
        82,
        251,
        233,
        156,
        12,
        52,
        184,
        202
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true
        },
        {
          "name": "feeRecipient"
        },
        {
          "name": "feeShares",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "feeRecipient"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "shareMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "claimWithdraw",
      "discriminator": [
        232,
        89,
        154,
        117,
        16,
        204,
        182,
        224
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "ticket"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "writable": true
        },
        {
          "name": "epochRecord",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  112,
                  111,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "ticket.epoch",
                "account": "withdrawTicket"
              }
            ]
          }
        },
        {
          "name": "idleVault",
          "writable": true
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "deposit",
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "idleVault",
          "writable": true
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "state.epoch",
                "account": "vaultState"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "forceRecall",
      "discriminator": [
        33,
        95,
        108,
        214,
        167,
        203,
        143,
        29
      ],
      "accounts": [
        {
          "name": "sentinel",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "shareMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "idleVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  100,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "bondVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "geminiDestination"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "settings",
          "type": {
            "defined": {
              "name": "vaultSettings"
            }
          }
        }
      ]
    },
    {
      "name": "pause",
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "sentinel",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "postBond",
      "discriminator": [
        168,
        151,
        202,
        119,
        163,
        58,
        147,
        247
      ],
      "accounts": [
        {
          "name": "payer",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bondVault",
          "writable": true
        },
        {
          "name": "payerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "releaseBond",
      "discriminator": [
        15,
        50,
        71,
        19,
        101,
        191,
        81,
        142
      ],
      "accounts": [
        {
          "name": "operator",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "bondVault",
          "writable": true
        },
        {
          "name": "operatorUsdc",
          "writable": true
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "repay",
      "discriminator": [
        234,
        103,
        67,
        82,
        208,
        234,
        219,
        166
      ],
      "accounts": [
        {
          "name": "payer",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "idleVault",
          "writable": true
        },
        {
          "name": "payerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "requestDraw",
      "discriminator": [
        22,
        180,
        8,
        81,
        47,
        21,
        86,
        159
      ],
      "accounts": [
        {
          "name": "operator",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "idleVault",
          "writable": true
        },
        {
          "name": "bondVault"
        },
        {
          "name": "geminiDestination",
          "docs": [
            "Gate 7: the only account a draw can pay."
          ],
          "writable": true
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "categories",
          "type": "u32"
        }
      ]
    },
    {
      "name": "requestWithdraw",
      "discriminator": [
        137,
        95,
        187,
        96,
        250,
        138,
        31,
        182
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true
        },
        {
          "name": "ownerShares",
          "writable": true
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  116,
                  104,
                  100,
                  114,
                  97,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "state.epoch",
                "account": "vaultState"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u64"
        }
      ]
    },
    {
      "name": "settleEpoch",
      "discriminator": [
        148,
        223,
        178,
        38,
        201,
        158,
        167,
        13
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "idleVault"
        },
        {
          "name": "epochRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  112,
                  111,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "state.epoch",
                "account": "vaultState"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "slashBond",
      "discriminator": [
        143,
        246,
        51,
        243,
        88,
        198,
        217,
        48
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "idleVault",
          "writable": true
        },
        {
          "name": "bondVault",
          "writable": true
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "submitNav",
      "discriminator": [
        132,
        186,
        250,
        155,
        121,
        127,
        246,
        0
      ],
      "accounts": [
        {
          "name": "submitter",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "idleVault",
          "writable": true
        },
        {
          "name": "bondVault",
          "writable": true
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "report",
          "type": {
            "defined": {
              "name": "navReport"
            }
          }
        }
      ]
    },
    {
      "name": "sweepProfit",
      "discriminator": [
        10,
        73,
        183,
        107,
        147,
        24,
        115,
        90
      ],
      "accounts": [
        {
          "name": "payer",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "idleVault",
          "writable": true
        },
        {
          "name": "payerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "unpause",
      "discriminator": [
        169,
        144,
        4,
        38,
        10,
        141,
        188,
        255
      ],
      "accounts": [
        {
          "name": "sentinel",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "depositTicket",
      "discriminator": [
        147,
        140,
        28,
        139,
        216,
        92,
        230,
        198
      ]
    },
    {
      "name": "epochRecord",
      "discriminator": [
        193,
        72,
        26,
        28,
        161,
        98,
        58,
        132
      ]
    },
    {
      "name": "vaultConfig",
      "discriminator": [
        99,
        86,
        43,
        216,
        184,
        102,
        119,
        77
      ]
    },
    {
      "name": "vaultState",
      "discriminator": [
        228,
        196,
        82,
        165,
        98,
        210,
        235,
        152
      ]
    },
    {
      "name": "withdrawTicket",
      "discriminator": [
        237,
        23,
        164,
        58,
        53,
        248,
        240,
        94
      ]
    }
  ],
  "events": [
    {
      "name": "bondSlashed",
      "discriminator": [
        59,
        7,
        252,
        195,
        234,
        156,
        42,
        54
      ]
    },
    {
      "name": "deposited",
      "discriminator": [
        111,
        141,
        26,
        45,
        161,
        35,
        100,
        57
      ]
    },
    {
      "name": "drawn",
      "discriminator": [
        87,
        120,
        94,
        189,
        167,
        148,
        44,
        221
      ]
    },
    {
      "name": "epochSettled",
      "discriminator": [
        32,
        219,
        45,
        156,
        250,
        115,
        190,
        255
      ]
    },
    {
      "name": "navSubmitted",
      "discriminator": [
        120,
        126,
        79,
        70,
        20,
        182,
        154,
        12
      ]
    },
    {
      "name": "recallOpened",
      "discriminator": [
        20,
        93,
        120,
        214,
        166,
        26,
        113,
        217
      ]
    },
    {
      "name": "returned",
      "discriminator": [
        10,
        240,
        87,
        178,
        40,
        21,
        158,
        220
      ]
    },
    {
      "name": "withdrawRequested",
      "discriminator": [
        114,
        16,
        240,
        206,
        93,
        128,
        151,
        39
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6001,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6002,
      "name": "invalidParams",
      "msg": "Invalid vault parameters"
    },
    {
      "code": 6003,
      "name": "invalidAttestors",
      "msg": "Invalid attestor set or quorum"
    },
    {
      "code": 6004,
      "name": "invalidMint",
      "msg": "USDC mint must have 6 decimals"
    },
    {
      "code": 6005,
      "name": "unauthorized",
      "msg": "Signer does not hold the required role"
    },
    {
      "code": 6006,
      "name": "paused",
      "msg": "Vault is paused"
    },
    {
      "code": 6007,
      "name": "depositCapExceeded",
      "msg": "Deposit would exceed the vault's TVL cap"
    },
    {
      "code": 6008,
      "name": "epochNotSettled",
      "msg": "Ticket belongs to an epoch that has not settled"
    },
    {
      "code": 6009,
      "name": "insufficientIdle",
      "msg": "Idle USDC cannot cover this claim yet"
    },
    {
      "code": 6010,
      "name": "gateBondCoverage",
      "msg": "Gate 1: operator bond does not cover outstanding principal"
    },
    {
      "code": 6011,
      "name": "gateAbsoluteCap",
      "msg": "Gate 2: outstanding principal would exceed the absolute cap"
    },
    {
      "code": 6012,
      "name": "gateNavShare",
      "msg": "Gate 3: outstanding principal would exceed the allowed share of NAV"
    },
    {
      "code": 6013,
      "name": "gateIdleBuffer",
      "msg": "Gate 4: idle buffer would fall below the minimum or queued withdrawals"
    },
    {
      "code": 6014,
      "name": "gateNavStale",
      "msg": "Gate 5: no fresh quorum-signed NAV report"
    },
    {
      "code": 6015,
      "name": "gateHealth",
      "msg": "Gate 6: attested Gemini equity is below the health threshold"
    },
    {
      "code": 6016,
      "name": "gateRecallOpen",
      "msg": "Gate 8: a recall is open"
    },
    {
      "code": 6017,
      "name": "gatePerDrawLimit",
      "msg": "Gate 8: draw exceeds the per-draw limit"
    },
    {
      "code": 6018,
      "name": "bondLocked",
      "msg": "Bond is locked behind outstanding draws or an open recall"
    },
    {
      "code": 6019,
      "name": "navReplay",
      "msg": "NAV report timestamp is not newer than the last report"
    },
    {
      "code": 6020,
      "name": "navFromFuture",
      "msg": "NAV report timestamp is in the future"
    },
    {
      "code": 6021,
      "name": "navTooOld",
      "msg": "NAV report is too old"
    },
    {
      "code": 6022,
      "name": "quorumNotMet",
      "msg": "Not enough attestor signatures for quorum"
    },
    {
      "code": 6023,
      "name": "malformedSignature",
      "msg": "Malformed ed25519 instruction"
    },
    {
      "code": 6024,
      "name": "epochTooSoon",
      "msg": "Epoch cannot settle yet"
    },
    {
      "code": 6025,
      "name": "navRequired",
      "msg": "A fresh NAV report is required before settling"
    },
    {
      "code": 6026,
      "name": "conditionNotMet",
      "msg": "Breaker condition does not hold"
    },
    {
      "code": 6027,
      "name": "nothingDrawn",
      "msg": "Nothing is drawn"
    },
    {
      "code": 6028,
      "name": "noFees",
      "msg": "No fees owed"
    }
  ],
  "types": [
    {
      "name": "bondSlashed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "depositTicket",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "deposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "drawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "categories",
            "type": "u32"
          },
          {
            "name": "outstanding",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "epochRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "assets",
            "docs": [
              "NAV and shares at settlement, after fees: the price every ticket of this epoch uses."
            ],
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "settledAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "epochSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "assets",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "feeShares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "navReport",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "equity",
            "type": "u64"
          },
          {
            "name": "positionsHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "rebateTotal",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "navSubmitted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "equity",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "signers",
            "type": "u8"
          },
          {
            "name": "positionsHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "rebateTotal",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "recall",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "repaid",
            "type": "u64"
          },
          {
            "name": "openedAt",
            "type": "i64"
          },
          {
            "name": "deadline",
            "type": "i64"
          },
          {
            "name": "reason",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "recallOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "deadline",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "returned",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "principal",
            "type": "u64"
          },
          {
            "name": "outstanding",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "shareMint",
            "type": "pubkey"
          },
          {
            "name": "idleVault",
            "type": "pubkey"
          },
          {
            "name": "bondVault",
            "type": "pubkey"
          },
          {
            "name": "settings",
            "type": {
              "defined": {
                "name": "vaultSettings"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "authorityBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vaultParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bondMinBps",
            "docs": [
              "Gate 1: bond must cover this share of outstanding principal."
            ],
            "type": "u16"
          },
          {
            "name": "absoluteCap",
            "docs": [
              "Gate 2: hard cap on outstanding principal, in USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "drawnNavMaxBps",
            "docs": [
              "Gate 3: outstanding principal as a share of NAV."
            ],
            "type": "u16"
          },
          {
            "name": "bufferBps",
            "docs": [
              "Gate 4: idle USDC kept back as a share of NAV."
            ],
            "type": "u16"
          },
          {
            "name": "healthMinBps",
            "docs": [
              "Gate 6: attested equity over outstanding principal needed to draw."
            ],
            "type": "u16"
          },
          {
            "name": "recallHealthBps",
            "docs": [
              "Below this, a NAV report slashes the bond and opens a full recall."
            ],
            "type": "u16"
          },
          {
            "name": "perDrawBps",
            "docs": [
              "Gate 8: largest single draw as a share of `absolute_cap`."
            ],
            "type": "u16"
          },
          {
            "name": "navMaxAgeSecs",
            "docs": [
              "Gate 5: oldest NAV report a draw or settlement accepts."
            ],
            "type": "i64"
          },
          {
            "name": "navSilenceSecs",
            "docs": [
              "With principal drawn and no report for this long, anyone can open a recall."
            ],
            "type": "i64"
          },
          {
            "name": "recallDeadlineSecs",
            "type": "i64"
          },
          {
            "name": "epochMinSecs",
            "type": "i64"
          },
          {
            "name": "performanceFeeBps",
            "docs": [
              "Taken above the share price high-water mark at each settlement."
            ],
            "type": "u16"
          },
          {
            "name": "depositCap",
            "docs": [
              "Cap on NAV plus pending deposits. Zero means no cap."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultSettings",
      "docs": [
        "Roles, destination and limits. Fixed at initialisation; no instruction changes them."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "vaultParams"
              }
            }
          },
          {
            "name": "sentinel",
            "type": "pubkey"
          },
          {
            "name": "operator",
            "type": "pubkey"
          },
          {
            "name": "feeRecipient",
            "type": "pubkey"
          },
          {
            "name": "geminiDestination",
            "docs": [
              "USDC token account of the operator's Gemini deposit address."
            ],
            "type": "pubkey"
          },
          {
            "name": "attestors",
            "type": {
              "array": [
                "pubkey",
                5
              ]
            }
          },
          {
            "name": "attestorCount",
            "type": "u8"
          },
          {
            "name": "quorum",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vaultState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "totalShares",
            "docs": [
              "Shares outstanding, including settled deposits not yet claimed and fee shares owed."
            ],
            "type": "u64"
          },
          {
            "name": "drawnPrincipal",
            "type": "u64"
          },
          {
            "name": "geminiEquity",
            "docs": [
              "Last attested equity, adjusted for draws and repayments since."
            ],
            "type": "u64"
          },
          {
            "name": "navAt",
            "docs": [
              "Signed timestamp of the last accepted NAV report."
            ],
            "type": "i64"
          },
          {
            "name": "positionsHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "rebateTotal",
            "type": "u64"
          },
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "lastSettleAt",
            "type": "i64"
          },
          {
            "name": "pendingDeposits",
            "docs": [
              "USDC deposited this epoch, waiting for the epoch price."
            ],
            "type": "u64"
          },
          {
            "name": "pendingWithdrawShares",
            "docs": [
              "Shares burned for withdrawal this epoch, still counted in `total_shares`."
            ],
            "type": "u64"
          },
          {
            "name": "reservedWithdrawals",
            "docs": [
              "USDC owed to settled withdrawal tickets."
            ],
            "type": "u64"
          },
          {
            "name": "feeSharesOwed",
            "type": "u64"
          },
          {
            "name": "highWaterPrice",
            "type": "u128"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "recall",
            "type": {
              "defined": {
                "name": "recall"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "withdrawRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "withdrawTicket",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "authoritySeed",
      "type": "bytes",
      "value": "[97, 117, 116, 104, 111, 114, 105, 116, 121]"
    },
    {
      "name": "bondSeed",
      "type": "bytes",
      "value": "[98, 111, 110, 100]"
    },
    {
      "name": "configSeed",
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "depositSeed",
      "type": "bytes",
      "value": "[100, 101, 112, 111, 115, 105, 116]"
    },
    {
      "name": "epochSeed",
      "type": "bytes",
      "value": "[101, 112, 111, 99, 104]"
    },
    {
      "name": "idleSeed",
      "type": "bytes",
      "value": "[105, 100, 108, 101]"
    },
    {
      "name": "navDomain",
      "docs": [
        "Prefix of the message attestors sign for a NAV report."
      ],
      "type": "bytes",
      "value": "[77, 79, 85, 83, 69, 84, 82, 65, 80, 95, 78, 65, 86, 95, 86, 49]"
    },
    {
      "name": "shareMintSeed",
      "type": "bytes",
      "value": "[115, 104, 97, 114, 101, 115]"
    },
    {
      "name": "stateSeed",
      "type": "bytes",
      "value": "[115, 116, 97, 116, 101]"
    },
    {
      "name": "withdrawSeed",
      "type": "bytes",
      "value": "[119, 105, 116, 104, 100, 114, 97, 119]"
    }
  ]
};
