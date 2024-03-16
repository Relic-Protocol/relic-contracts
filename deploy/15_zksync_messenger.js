const { ethers, companionNetworks } = require("hardhat");

module.exports = async ({getNamedAccounts, deployments}) => {
    if (network.config.bridged === true || network.config.l2Native === true) {
        return;
    }
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    const reliquary = await ethers.getContract("Reliquary");
    const blockHistory = await ethers.getContract("BlockHistory");

    const diamondProxy = config.networks[
        companionNetworks["zkSync"].deployments.getNetworkName()
    ].diamondProxy

    await deploy("ZkSyncBlockHashMessenger", {
        from: deployer,
        args: [reliquary.address, blockHistory.address, diamondProxy],
        log: true,
    });
};

module.exports.tags = ["ZkSyncBlockHashMessenger"];
module.exports.dependencies = ["Reliquary", "BlockHistory"];
