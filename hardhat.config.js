require("dotenv").config();
require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("hardhat-deploy");
require("hardhat-prettier");
require("ethers");

// for older node without array.at
require("core-js/features/array/at");

let { execFileSync } = require("child_process");
let {
  TASK_COMPILE_GET_COMPILATION_TASKS,
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD
} = require("hardhat/builtin-tasks/task-names");

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

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL || "";

/**
 * @type import("hardhat/config").HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: "0.8.12",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      }
    }
  },
  networks: {
    hardhat: {
      forking: {
        url: MAINNET_RPC_URL,
        blockNumber: 15040512,
      },
      saveDeployments: true,
    }
  },
  mocha: {
    timeout: 10000000
  },
  namedAccounts: {
    deployer: {
      default: 0
    }
  },
  relic: {
    vkSizes: [
        0x40, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000,
        0x8000, 0x10000, 0x20000, 0x40000, 0x80000, 0x100000
    ]
  }
};
