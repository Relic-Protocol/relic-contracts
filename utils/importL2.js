const { ethers, companionNetworks, network } = require("hardhat")
const { Provider: ZkProvider, Wallet: ZkWallet, utils: zksyncUtils } = require("zksync-web3")
const { RelicClient, UnknownError, utils: relicUtils } = require("@relicprotocol/client")

const { getMerkleRootsSlot } = require("./slots")
const { getGasOptions } = require("./gas")
const {
  getL1Provider,
  getSigner,
  getProxyContract,
  getL1Contract,
  getMessengerName,
  patchProviderPolling
} = require("./network")

const {
  waitForTrustedImport
} = require("./blockhistory")


async function getMessengerParams(blockNum, blockHash) {
  // compute gas estimate
  const l2BlockHistory = await ethers.getContract("BlockHistory")
  const messenger = await getL1Contract(getMessengerName())
  const call = await l2BlockHistory.populateTransaction.importTrustedHash(blockNum, blockHash)
  let params, l2Fee;
  if (network.config.zksync) {
    const request = {
      contractAddress: call.to,
      calldata: call.data,
      caller: zksyncUtils.applyL1ToL2Alias(messenger.address)
    }
    const zkProvider = new ZkProvider(network.config.url)
    const zkWallet = new ZkWallet(network.config.accounts[0], zkProvider, getL1Provider())
    const l2GasLimit = await zkWallet.provider.estimateL1ToL2Execute(request)
    const l2Tx = await zkWallet.getRequestExecuteTx(request)
    l2Fee = l2Tx.value

    const l2GasPerPubdataByteLimit = zksyncUtils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT
    params = ethers.utils.defaultAbiCoder.encode(["uint256", "uint256"], [l2GasLimit, l2GasPerPubdataByteLimit])
  } else if (network.config.optimism) {
    const l2GasLimit = await l2BlockHistory.provider.estimateGas({
      ...call,
      from: zksyncUtils.applyL1ToL2Alias(messenger.address) // same alias rules as zkSync
    })
    params = ethers.utils.defaultAbiCoder.encode(["uint64"], [l2GasLimit])
    l2Fee = 0
  } else {
    throw new Error("unsupported network")
  }
  return { params, l2Fee }
}

async function commitCurrentL1BlockHash(minBlockNumber) {
  if (network.config.optimism !== true) throw Error("incompatible network")
  const l2BlockHistory = await ethers.getContract("BlockHistory")
  patchProviderPolling(l2BlockHistory.provider)

  if (minBlockNumber && minBlockNumber > 0) {
    const blockContract = new ethers.Contract(
      "0x4200000000000000000000000000000000000015",
      ['function number() view returns (uint256)'],
      l2BlockHistory.provider
    )
    console.log(`Waiting for L1 block provider to reach ${minBlockNumber}...`)
    while ((await blockContract.number()).lt(minBlockNumber)) {
      await new Promise(res => setTimeout(res, 6000))
    }
  }

  const tx = await l2BlockHistory.commitCurrentL1BlockHash(getGasOptions())
  console.log(`committing current L1 block in tx ${tx.hash}...`)
  await tx.wait()
}

async function sendBlockHash(blockNum) {
  if (network.config.bridged !== true) throw Error("not on bridged network")

  const l1Provider = getL1Provider()
  const messenger = await getL1Contract(getMessengerName())

  const proxyBlockHistory = await ethers.getContract("BlockHistory")

  const blockHash = await l1Provider.getBlock(blockNum).then(b => b.hash)

  const relic = await RelicClient.fromProvider(l1Provider)
  const { blockProof } = await relic.api.blockProof(blockHash)

  const { params, l2Fee } = await getMessengerParams(blockNum, blockHash)
  const tx = await messenger.sendBlockHash(
    proxyBlockHistory.address,
    params,
    blockNum,
    blockHash,
    blockProof,
    { ...getGasOptions(), gasLimit: 1000000, value: l2Fee }
  )

  console.log(`waiting for L1 tx: ${tx.hash}`)
  await tx.wait()
  console.log(`waiting for L2 tx...`)
  await waitForTrustedImport(blockHash)
}

const MAX_IMPORT_SIZE = 32

async function proxyImport(blockHistory, relic, block, index, numRoots) {
  const l1BlockHistory = await companionNetworks['l1'].deployments.get("BlockHistory")
  const merkleRootsSlot = getMerkleRootsSlot(l1BlockHistory)
  const account = l1BlockHistory.address
  const slots = [...new Array(numRoots).keys()].map(i => relicUtils.mapElemSlot(merkleRootsSlot, index + i))

  console.log(`Fetching slot proofs for [${index}, ..., ${index + numRoots})`)

  let proof = ""
  do {
    try {
      let {} = { proof } = await relic.multiStorageSlotProver.getProofData({block, account, slots})
    } catch(e) {
      if (! (e instanceof UnknownError) || e.message != "No response data from API") {
        throw e
      }
      console.log("Error fetching proof... retrying")
    }
  } while( !proof );

  const [ _acc, accountProof, header, _bp, proofNodes, _s, slotProofs, _ih] = ethers.utils.defaultAbiCoder.decode(
    [
      'address',
      'bytes',
      'bytes',
      'bytes',
      'bytes',
      'uint256[]',
      'bytes',
      'bool',
    ],
    proof
  )
  // re-encode for the blockhistory format
  proof = ethers.utils.defaultAbiCoder.encode(
    [
      'uint256',
      'uint256',
      'bytes',
      'bytes',
      'uint256[]',
      'bytes',
      'bytes'
    ],
    [ index, numRoots, header, accountProof, slots, proofNodes, slotProofs ]
  )

  console.log(`Importing [${index}, ..., ${index + numRoots})`)
  let tx = await blockHistory.importRoots(proof, getGasOptions())
  console.log(`Tx hash: ${tx.hash}`)
  await tx.wait()
}

async function importMerkleRoots(blockNum, index, numRoots) {
  const blockHistory = await ethers.getContract("BlockHistory")

  const l1Provider = getL1Provider()
  const relic = await RelicClient.fromProvider(l1Provider)

  for (let i = 0; i < numRoots; i += MAX_IMPORT_SIZE) {
    const start = index + i
    const size = Math.min(MAX_IMPORT_SIZE, numRoots - i)
    await proxyImport(blockHistory, relic, blockNum, start, size)
  }
}

async function lastImportedRoot(blockHistory) {
  const filter = blockHistory.filters.ImportMerkleRoot()
  let logs = null
  while (logs === null) {
    try {
      logs = await blockHistory.queryFilter(filter)
    } catch (e) {
      // ProviderError: no backends available for method
      if (e.code !== -32011) {
        throw e;
      }
    }
  }
  const index = logs.length > 0 ? logs[logs.length - 1].args.index.toNumber() : -1
  const blockNum = logs.length > 0 ? logs[logs.length - 1].blockNumber : -1
  return { index, blockNum }
}

async function waitForL1Update() {
  if (network.config.bridged !== true) throw Error("not on bridged network")
  const l2BlockHistory = await ethers.getContract("BlockHistory")
  const l1BlockHistory = await getL1Contract("BlockHistory")
  patchProviderPolling(l1BlockHistory.provider);
  patchProviderPolling(l2BlockHistory.provider);

  while (true) {
    const lastL1 = await lastImportedRoot(l1BlockHistory)
    const lastL2 = await lastImportedRoot(l2BlockHistory)

    if (lastL2.index < lastL1.index) {
      return {
        blockNum: lastL1.blockNum,
        index: lastL2.index + 1,
        numRoots: lastL1.index - lastL2.index
      }
    }

    console.log("L2 is caught up, waiting for new import on L1...")
    await new Promise(res => l1BlockHistory.once("ImportMerkleRoot", res))
  }
}

module.exports = {
  commitCurrentL1BlockHash,
  getMessengerName,
  sendBlockHash,
  importMerkleRoots,
  waitForL1Update,
}
