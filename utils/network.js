const { companionNetworks } = require("hardhat")
const { EthersProviderWrapper } = require("@nomiclabs/hardhat-ethers/internal/ethers-provider-wrapper")
const util = require("util")

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
    } else {
      return "OptimismBlockHashMessenger"
    }
  } else {
    throw Error("unsupported network")
  }
}


function getL1Provider() {
  const provider = new EthersProviderWrapper(
    companionNetworks['l1'].provider,
    companionNetworks['l1'].deployments.getNetworkName()
  )
  patchProviderPolling(provider)
  return provider
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


module.exports = {
  getSigner,
  getProxyContract,
  getL1Contract,
  getL1Provider,
  getMessengerName,
  patchProviderPolling
}
