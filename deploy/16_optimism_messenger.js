const { companionNetworks, ethers } = require("hardhat");

module.exports = async ({getNamedAccounts, deployments}) => {
    if (network.config.bridged === true || network.config.l2Native === true) {
        return;
    }
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    const reliquary = await ethers.getContract("Reliquary");
    const blockHistory = await ethers.getContract("BlockHistory");

    const portal = config.networks[
        companionNetworks["optimism"].deployments.getNetworkName()
    ].portal
    await deploy("OptimismBlockHashMessenger", {
        from: deployer,
        args: [reliquary.address, blockHistory.address, portal],
        log: true,
    });
};

module.exports.tags = ["OptimismBlockHashMessenger"];
module.exports.dependencies = ["Reliquary", "BlockHistory"];
