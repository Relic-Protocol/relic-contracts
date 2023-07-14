
const { ethers } = require("hardhat");

module.exports = async ({getNamedAccounts, deployments}) => {
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    const reliquary = await ethers.getContract("Reliquary");
    const blockHistory = await ethers.getContract("BlockHistory");

    await deploy("TransactionProver", {
        from: deployer,
        args: [blockHistory.address, reliquary.address],
        log: true,
    });
};

module.exports.tags = ["TransactionProver"];
module.exports.dependencies = ["Reliquary", "BlockHistory"];
