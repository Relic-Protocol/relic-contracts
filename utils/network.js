const { companionNetworks } = require("hardhat")
const { EthersProviderWrapper } = require("@nomiclabs/hardhat-ethers/internal/ethers-provider-wrapper")
const util = require("util")

const BEACON_GENESIS_TIMESTAMP = {
  1: 1606824023,
  11155111: 1655733600,
}

function patchProviderPolling(provider) {
  // if `provider` is a proxy, extract the inner object
  if (util.types.isProxy(provider)) {
    provider.__proto__.__interceptor = function () { provider = this }
    provider.__interceptor()
  }
  provider.pollingInterval = 40000
  if (!provider._getNetwork) {
    provider._getNetwork = provider.getNetwork
  }
  provider.getNetwork = function() {
    if (this._network) { return Promise.resolve(this._network) }
    return this._getNetwork()
  }
}

function getMessengerName() {
  if (network.config.bridged !== true) {
    throw Error("not on bridged network")
  }
  if (network.config.zksync) {
    return "ZkSyncBlockHashMessenger"
  } else if (network.config.optimism) {
    if (network.name.includes("base")) {
      return "BaseBlockHashMessenger"
    } else if (network.name.includes("blast")) {
      return "BlastBlockHashMessenger"
    } else {
      return "OptimismBlockHashMessenger"
    }
  } else {
    throw Error("unsupported network")
  }
}


function getL1Provider() {
  if (companionNetworks['l1']) {
    const provider = new EthersProviderWrapper(
      companionNetworks['l1'].provider,
      companionNetworks['l1'].deployments.getNetworkName()
    )
    patchProviderPolling(provider)
    return provider
  } else {
    return ethers.provider
  }
}

function getSigner(network, address) {
  return companionNetworks[network].deployments.getSigner(address)
}

async function getProxyContract(name) {
  const deployment = await companionNetworks['proxy'].deployments.get(name)
  const signer = await getSigner('proxy', deployment.receipt.from)
  return new ethers.Contract(deployment.address, deployment.abi, signer)
}

async function getL1Contract(name) {
  const deployment = await companionNetworks['l1'].deployments.get(name)
  const signer = await companionNetworks['l1'].deployments.getSigner(deployment.receipt.from)
  patchProviderPolling(signer.provider)
  return new ethers.Contract(deployment.address, deployment.abi, signer)
}

async function getLogs(provider, filter) {
    if (filter.fromBlock === undefined) {
      filter.fromBlock = 0
    }
    while (true) {
        try {
            logs = await provider.getLogs(filter)
        } catch (e) {
            if (e.code == -32011) {
              // ProviderError: no backends available for method
              continue
            } else if (e.code == -32614) {
              // ProviderError: eth_getLogs is limited to a 10,000 range
              if (filter.fromBlock != 0) {
                filter.toBlock = filter.fromBlock + 10_000;
              } else if (filter.toBlock === undefined) {
                filter.fromBlock = await provider.getBlockNumber() - 9900;
              } else {
                // unfixable
                throw e;
              }
            } else if (e.code == -32000) {
              // ProviderError: block range too large
              throw e;
            } else {
              throw e;
            }
            continue
        }
        return logs
    }
}

function beaconGenesisTimestamp(chainId) {
  if (!isL1ChainId(chainId)) {
    throw new NotL1Network(chainId)
  }
  return BEACON_GENESIS_TIMESTAMP[chainId]
}

function timestampToSlot(timestamp, chainId) {
  if (!isL1ChainId(chainId)) {
    throw new NotL1Network(chainId)
  }
  const timeDiff = timestamp - BEACON_GENESIS_TIMESTAMP[chainId]
  if (timeDiff % TIME_PER_SLOT != 0) {
    throw new UnexpectedSlotTime(timestamp)
  }
  return timeDiff / TIME_PER_SLOT
}

function slotToTimestamp(slot, chainId) {
  if (!isL1ChainId(chainId)) {
    throw new NotL1Network(chainId)
  }
  return BEACON_GENESIS_TIMESTAMP[chainId] + TIME_PER_SLOT * slot
}

module.exports = {
  getSigner,
  getProxyContract,
  getLogs,
  getL1Contract,
  getL1Provider,
  getMessengerName,
  patchProviderPolling,
  beaconGenesisTimestamp,
  timestampToSlot,
  slotToTimestamp,
}
