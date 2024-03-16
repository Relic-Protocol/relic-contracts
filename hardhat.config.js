const path = require("path");

require("dotenv").config();
require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("hardhat-deploy");
const ethers = require("ethers");
require("@matterlabs/hardhat-zksync-deploy");
require("@matterlabs/hardhat-zksync-solc");
require("@matterlabs/hardhat-zksync-verify");

// for older node without array.at
require("core-js/features/array/at");

let { execFileSync } = require("child_process");
let {
  TASK_COMPILE_GET_COMPILATION_TASKS,
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS
} = require("hardhat/builtin-tasks/task-names");
const { DEFAULT_L2_CONTRACT_ADDRESSES } = require("@eth-optimism/sdk");

let TASK_BUILD_VERIFIER = "compile:build-verifier";

subtask(TASK_BUILD_VERIFIER, "build the yul Recursive PLONK verifier")
  .setAction(async function (args, hre, runSuper) {
    let solcVersion = hre.config.solidity.compilers[0].version;
    const solcBuild = await run(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, { quiet: true, solcVersion });

    let sourceName = "contracts/Verifier.yul";
    let bytecode =
      execFileSync(solcBuild.compilerPath, ["--strict-assembly", "--bin", sourceName])
      .toString()
      .split("\n")
      .at(-2);

    let abi = (await hre.artifacts.readArtifact("IRecursiveVerifier")).abi;
    let constructor =  {
        "inputs": [ { internalType: "uint256[35]", type: "uint256[35]" } ],
        "stateMutability": "nonpayable",
        "type": "constructor"
    };
    abi.push(constructor);
    let artifact = {
      "_format": "hh-sol-artifact-1",
      "contractName": "Verifier",
      sourceName,
      abi,
      bytecode,
      deployedBytecode: "0x",
      "linkReferences": {},
      "deployedLinkReferences": {}
    };
    await hre.artifacts.saveArtifactAndDebugFile(artifact);
    hre.artifacts.addValidArtifacts([{sourceName, artifacts: ["Verifier"]}]);
 });

subtask(TASK_COMPILE_GET_COMPILATION_TASKS, "hooked to build yul verifier")
  .setAction(async function (args, hre, runSuper) {
    let tasks = await runSuper();
    tasks = tasks.concat([TASK_BUILD_VERIFIER]);
    return tasks;
  });

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
task("accounts", "Prints the list of accounts", async (taskArgs, hre) => {
  const accounts = await hre.ethers.getSigners();

  for (const account of accounts) {
    console.log(account.address);
  }
});

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL || "";
const MAINNET_PRIVKEY = process.env.MAINNET_PRIVKEY || "";
const SIGNING_PRIVKEY = process.env.SIGNING_PRIVKEY || "";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const SEPOLIA_PRIVKEY = process.env.SEPOLIA_PRIVKEY || "";

const MAINNET_BEACON_URL = process.env.MAINNET_BEACON_URL || "";
const SEPOLIA_BEACON_URL = process.env.SEPOLIA_BEACON_URL || "";

/**
 * @type import("hardhat/config").HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: "0.8.13",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      }
    }
  },
  zksolc: {
    version: "1.3.17",
    compilerSource: "binary",
    settings: {},
  },
  mocha: {
    timeout: 10000000
  },
  networks: {
    sepolia: {
      url: SEPOLIA_RPC_URL,
      accounts: SEPOLIA_PRIVKEY.length ? [ SEPOLIA_PRIVKEY ] : [],
      zksync: false,
      companionNetworks: {
        zkSync: "zkTestnet",
        optimism: "opSepolia",
        base: "baseSepolia",
        blast: "blastSepolia"
      },
      backendUrl: 'https://api.sepolia.relicprotocol.com/v1/',
      proverUrl: 'https://api.sepolia.relicprotocol.com/v1/',
      beaconUrl: SEPOLIA_BEACON_URL,
      capellaSlot: 1818624,
      denebSlot: 4243456,
      upgradeBlock: 5185536,
      beaconOracleContract: "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"
    },
    mainnet: {
      url: MAINNET_RPC_URL,
      accounts:
        (MAINNET_PRIVKEY.length ? [ MAINNET_PRIVKEY ] : [])
          .concat(SIGNING_PRIVKEY.length ? [ SIGNING_PRIVKEY ] : []),
      zksync: false,
      companionNetworks: {
        zkSync: "zkMainnet",
        optimism: "opMainnet",
        base: "baseMainnet"
      },
      backendUrl: 'https://api.mainnet.relicprotocol.com/v1/',
      proverUrl: 'https://api.mainnet.relicprotocol.com/v1/',
      beaconUrl: MAINNET_BEACON_URL,
      capellaSlot: 6209536,
      denebSlot: 8626176,
      upgradeBlock: 19423232,
      beaconOracleContract: "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"
    },
    hardhat: {
      forking: {
        url: MAINNET_RPC_URL,
        blockNumber: 17055744,
      },
      saveDeployments: true,
      zksync: false,
      companionNetworks: {
        zkSync: "zkMainnet",
        optimism: "opMainnet",
        base: "baseMainnet",
        blast: "blastSepolia"
      },
      capellaSlot: 0,
      denebSlot: 0,
      upgradeBlock: 0, // TODO
      beaconOracleContract: "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"
    },
    localhost: {
      url: "http://localhost:8545/",
      zksync: false,
      accounts: SEPOLIA_PRIVKEY.length ? [ SEPOLIA_PRIVKEY ] : [],
      companionNetworks: {
        zkSync: "zkTestnet",
        optimism: "opSepolia",
        base: "baseSepolia"
      },
      beaconUrl: SEPOLIA_BEACON_URL,
      capellaSlot: 1818624,
      denebSlot: 4243456,
      upgradeBlock: 5185536,
      beaconOracleContract: "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"
    },
    zkTestnet: {
      url: process.env.ZKSYNC_ERA_SEPOLIA_RPC_URL || "https://sepolia.era.zksync.dev/",
      ethNetwork: process.env.SEPOLIA_RPC_URL || "[set SEPOLIA_RPC_URL]",
      verifyURL: 'https://explorer.sepolia.era.zksync.dev/contract_verification',
      bridged: true,
      zksync: true,
      diamondProxy: "0x9A6DE0f62Aa270A8bCB1e2610078650D539B1Ef9",
      companionNetworks: {
        l1: "sepolia"
      },
      accounts: SEPOLIA_PRIVKEY.length ? [ SEPOLIA_PRIVKEY ] : [],
    },
    zkMainnet: {
      url: process.env.ZKSYNC_ERA_MAINNET_RPC_URL || "https://mainnet.era.zksync.io",
      ethNetwork: process.env.MAINNET_RPC_URL || "[set MAINNET_RPC_URL]",
      verifyURL: 'https://zksync2-mainnet-explorer.zksync.io/contract_verification',
      bridged: true,
      zksync: true,
      diamondProxy: "0x32400084c286cf3e17e7b677ea9583e60a000324",
      companionNetworks: {
        l1: "mainnet"
      },
      accounts: MAINNET_PRIVKEY.length ? [ MAINNET_PRIVKEY ] : [],
    },
    opMainnet: {
      url: process.env.OPTIMISM_MAINNET_RPC_URL || "https://mainnet.optimism.io",
      ethNetwork: process.env.MAINNET_RPC_URL || "[set MAINNET_RPC_URL]",
      accounts: MAINNET_PRIVKEY.length ? [ MAINNET_PRIVKEY ] : [],
      bridged: true,
      optimism: true,
      portal: "0xbEb5Fc579115071764c7423A4f12eDde41f106Ed",
      companionNetworks: {
        l1: "mainnet"
      }
    },
    opSepolia: {
      url: process.env.OPTIMISM_SEPOLIA_RPC_URL || "https://sepolia.optimism.io",
      ethNetwork: process.env.SEPOLIA_RPC_URL || "[set SEPOLIA_RPC_URL]",
      accounts: SEPOLIA_PRIVKEY.length ? [ SEPOLIA_PRIVKEY ] : [],
      bridged: true,
      optimism: true,
      portal: "0x16Fc5058F25648194471939df75CF27A2fdC48BC",
      companionNetworks: {
        l1: "sepolia"
      }
    },
    baseMainnet: {
      url: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
      ethNetwork: process.env.MAINNET_RPC_URL || "[set MAINNET_RPC_URL]",
      accounts: MAINNET_PRIVKEY.length ? [ MAINNET_PRIVKEY ] : [],
      bridged: true,
      optimism: true,
      portal: "0x49048044D57e1C92A77f79988d21Fa8fAF74E97e",
      companionNetworks: {
        l1: "mainnet"
      }
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      ethNetwork: process.env.SEPOLIA_RPC_URL || "[set SEPOLIA_RPC_URL]",
      accounts: SEPOLIA_PRIVKEY.length ? [ SEPOLIA_PRIVKEY ] : [],
      bridged: true,
      optimism: true,
      portal: "0x49f53e41452C74589E85cA1677426Ba426459e85",
      companionNetworks: {
        l1: "sepolia"
      }
    },
    blastSepolia: {
      url: process.env.BLAST_SEPOLIA_RPC_URL || "https://sepolia.blast.io",
      ethNetwork: process.env.SEPOLIA_RPC_URL || "[set SEPOLIA_RPC_URL]",
      accounts: SEPOLIA_PRIVKEY.length ? [ SEPOLIA_PRIVKEY ] : [],
      bridged: true,
      optimism: true,
      portal: "0x2757E4430e694F27b73EC9C02257cab3a498C8C5",
      companionNetworks: {
        l1: "sepolia"
      },
      opContractsOverride: {
        l1: {
          AddressManager: ethers.constants.AddressZero,
          L1CrossDomainMessenger: '0x9338F298F29D3918D5D1Feb209aeB9915CC96333',
          L1StandardBridge: '0xDeDa8D3CCf044fE2A16217846B6e1f1cfD8e122f',
          StateCommitmentChain: ethers.constants.AddressZero,
          BondManager: ethers.constants.AddressZero,
          CanonicalTransactionChain: ethers.constants.AddressZero,
          OptimismPortal: '0x2757E4430e694F27b73EC9C02257cab3a498C8C5',
          L2OutputOracle: '0x311fF72DfE214ADF97618DD2E731637E8F41bD8c',
        },
        l2: DEFAULT_L2_CONTRACT_ADDRESSES
      }
    },
    opMainnetNative: {
      url: process.env.OPTIMISM_MAINNET_RPC_URL || "https://mainnet.optimism.io",
      ethNetwork: process.env.MAINNET_RPC_URL || "[set MAINNET_RPC_URL]",
      accounts: MAINNET_PRIVKEY.length ? [ MAINNET_PRIVKEY ] : [],
      l2Native: true,
      l2OutputOracle: "0xdfe97868233d1aa22e815a266982f2cf17685a27",
      companionNetworks: {
        l1: "mainnet",
        proxy: "opMainnet"
      }
    },
    opSepoliaNative: {
      url: process.env.OPTIMISM_SEPOLIA_RPC_URL || "https://sepolia.optimism.io",
      ethNetwork: process.env.SEPOLIA_RPC_URL || "[set SEPOLIA_RPC_URL]",
      accounts: SEPOLIA_PRIVKEY.length ? [ SEPOLIA_PRIVKEY ] : [],
      l2Native: true,
      l2OutputOracle: "0x90E9c4f8a994a250F6aEfd61CAFb4F2e895D458F",
      companionNetworks: {
        l1: "sepolia",
        proxy: "opSepolia"
      }
    },
    baseMainnetNative: {
      url: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
      ethNetwork: process.env.MAINNET_RPC_URL || "[set MAINNET_RPC_URL]",
      accounts: MAINNET_PRIVKEY.length ? [ MAINNET_PRIVKEY ] : [],
      l2Native: true,
      l2OutputOracle: "0x56315b90c40730925ec5485cf004d835058518A0",
      companionNetworks: {
        l1: "mainnet",
        proxy: "baseMainnet"
      }
    },
    baseSepoliaNative: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      ethNetwork: process.env.SEPOLIA_RPC_URL || "[set SEPOLIA_RPC_URL]",
      accounts: SEPOLIA_PRIVKEY.length ? [ SEPOLIA_PRIVKEY ] : [],
      l2Native: true,
      l2OutputOracle: "0x84457ca9D0163FbC4bbfe4Dfbb20ba46e48DF254",
      companionNetworks: {
        l1: "sepolia",
        proxy: "baseSepolia"
      }
    },
    blastSepoliaNative: {
      url: process.env.BLAST_SEPOLIA_RPC_URL || "https://sepolia.blast.io",
      ethNetwork: process.env.SEPOLIA_RPC_URL || "[set SEPOLIA_RPC_URL]",
      accounts: SEPOLIA_PRIVKEY.length ? [ SEPOLIA_PRIVKEY ] : [],
      l2Native: true,
      l2OutputOracle: "0x311fF72DfE214ADF97618DD2E731637E8F41bD8c",
      companionNetworks: {
        l1: "sepolia",
        proxy: "blastSepolia"
      }
    },
  },
  namedAccounts: {
    deployer: {
      // TODO: set deployer addresses for different networks
      default: 0
    }
  },
  relic: {
    vkSizes: [
        0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000, 0x80000, 0x100000
    ]
  },
};
