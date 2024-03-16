const { ethers } = require("hardhat")
const { getLogs, getL1Provider, patchProviderPolling, slotToTimestamp } = require("./network")

const NEGATIVE_ONE = ethers.BigNumber.from(-1)

function max(vals) {
    return vals.reduce((l, r) => l.gt(r) ? l : r)
}

async function getLastMerkleRootBlock(blockHistory) {
    if (!blockHistory.filters.ImportMerkleRoot) {
        return NEGATIVE_ONE
    }
    const logs = await getLogs(
        blockHistory.provider,
        blockHistory.filters.ImportMerkleRoot()
    )
    if (logs.length == 0) {
        return NEGATIVE_ONE
    }
    const vals = logs.map((l) => {
        const rootIdx = ethers.BigNumber.from(logs[logs.length - 1].topics[1])
        return rootIdx.add(1).mul(8192).sub(1)
    })
    return max(vals)
}

async function getLastSummaryBlock(blockHistory) {
  if (!blockHistory.filters.ImportBlockSummary) {
    return NEGATIVE_ONE
  }
  const logs = await getLogs(
    blockHistory.provider,
    blockHistory.filters.ImportBlockSummary()
  )
  if (logs.length == 0) {
    return NEGATIVE_ONE
  }
  const vals = logs.map((l) => {
    const slot = ethers.BigNumber.from(logs[logs.length - 1].topics[1])
    return slot.sub(1)
  })
  const maxSlot = max(vals)
  const { chainId } = await getL1Provider().getNetwork()
  const maxTimestamp = slotToTimestamp(maxSlot.toNumber(), chainId)
  const maxBlock = await blockForTimestamp(getL1Provider(), maxTimestamp)
  return ethers.BigNumber.from(maxBlock.number)
}

async function getLastTrustedBlock(blockHistory) {
    if (!blockHistory.filters.TrustedBlockHash) {
        return NEGATIVE_ONE
    }
    const logs = await getLogs(
        blockHistory.provider,
        blockHistory.filters.TrustedBlockHash()
    )
    if (logs.length == 0) {
        return NEGATIVE_ONE
    }
    const vals = logs.map((l) => {
        const [blockNum] = ethers.utils.defaultAbiCoder.decode(
            ["uint256", "bytes32"],
            logs[logs.length - 1].data
        )
        return blockNum
    })
    return max(vals)
}

async function getLastPrecomiitedBlock(blockHistory) {
    if (!blockHistory.filters.PrecomittedBlock) {
        return NEGATIVE_ONE
    }
    const logs = await getLogs(
        blockHistory.provider,
        blockHistory.filters.PrecomittedBlock()
    )
    if (logs.length == 0) {
        return NEGATIVE_ONE
    }
    const vals = logs.map((l) => {
        return ethers.BigNumber.from(logs[logs.length - 1].topics[1])
    })
    return max(vals)
}

async function getLastVerifiableBlock(blockHistory) {
    let legacy = null;
    if (blockHistory.preDencunBlockHistory) {
      legacy = await blockHistory.preDencunBlockHistory()
    }
    const vals = await Promise.all([
        legacy ? getLastVerifiableBlock(legacy): NEGATIVE_ONE,
        getLastMerkleRootBlock(blockHistory),
        getLastSummaryBlock(blockHistory),
        getLastTrustedBlock(blockHistory),
        getLastPrecomiitedBlock(blockHistory)
    ])
    // return the max
    return max(vals)
}

async function findImportedBlockNumber(minBlockNum) {
  const l2BlockHistory = await ethers.getContract("BlockHistory")
  patchProviderPolling(l2BlockHistory.provider)
  if (l2BlockHistory.filters.TrustedBlockHash) {
    const logs = await getLogs(
      l2BlockHistory.provider,
      l2BlockHistory.filters.TrustedBlockHash()
    )
    for (const log of logs) {
      const parsed = l2BlockHistory.interface.parseLog(log)
      if (parsed.args.number.toNumber() >= minBlockNum) {
        return parsed.args.number.toNumber()
      }
    }
  } else if (l2BlockHistory.filters.PrecomittedBlock) {
    const logs = await getLogs(
      l2BlockHistory.provider,
      l2BlockHistory.filters.PrecomittedBlock()
    )
    for (const log of logs) {
      const parsed = l2BlockHistory.interface.parseLog(log)
      if (parsed.args.blockNum.toNumber() >= minBlockNum) {
        return parsed.args.blockNum.toNumber()
      }
    }
  }
  return null
}

async function blockForTimestamp(provider, timestamp) {
  const current = await provider.getBlock('latest')
  if (current.timestamp < timestamp) throw new Error('timestamp after latest block')
  let start = await provider.getBlock(1)
  let end = current

  while (end.number - start.number > 1) {
    let quantile =
      (timestamp - start.timestamp) / (end.timestamp - start.timestamp)
    let nextNum =
      start.number + Math.floor((end.number - start.number) * quantile)
    if (nextNum == start.number) nextNum++
    if (nextNum == end.number) nextNum--
    let next = await provider.getBlock(nextNum)
    if (next.timestamp > timestamp) {
      end = next
    } else {
      start = next
    }
  }
  return start
}

async function waitForTrustedImport(block) {
  const header = await getL1Provider().getBlock(block)
  const proxyBlockHistory = await ethers.getContract("BlockHistory")
  patchProviderPolling(proxyBlockHistory.provider)
  const fromBlock = await blockForTimestamp(
    proxyBlockHistory.provider,
    header.timestamp
  ).then((b) => b.number)
  const filter = proxyBlockHistory.filters.PrecomittedBlock(header.number)
  while (true) {
    // query logs after setting up listener to avoid races
    const logs = await getLogs(proxyBlockHistory.provider, { ...filter, fromBlock })
    if (logs.length > 0) {
      return
    }
    await new Promise(res => setTimeout(res, 30000))
  }
}

async function getLastCachedSummary() {
  const proxyBlockHistory = await ethers.getContract("BlockHistory")
  patchProviderPolling(proxyBlockHistory.provider)
  const logs = await getLogs(
    proxyBlockHistory.provider,
    proxyBlockHistory.filters.ImportBlockSummary()
  )
  if (logs.length == 0) {
    return NEGATIVE_ONE
  }
  return max(logs.map(log => ethers.BigNumber.from(log.topics[1])))
}

module.exports = {
  blockForTimestamp,
  getLastVerifiableBlock,
  getLastCachedSummary,
  findImportedBlockNumber,
  waitForTrustedImport,
}
