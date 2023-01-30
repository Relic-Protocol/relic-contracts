const { ethers } = require("hardhat");

module.exports = async ({getNamedAccounts, deployments}) => {
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    const reliquary = await ethers.getContract("Reliquary");

    await deploy("EphemeralFacts", {
        from: deployer,
        args: [reliquary.address],
        log: true,
    });
};

module.exports.tags = ["EphemeralFacts"];
module.exports.dependencies = ["Reliquary"];