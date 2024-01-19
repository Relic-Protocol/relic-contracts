const { ethers } = require("hardhat");

module.exports = async ({getNamedAccounts, deployments}) => {
    if (network.config.bridged === true || network.config.optimism === true) {
        return;
    }

    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    const reliquary = await ethers.getContract("Reliquary");
    const blockHistory = await ethers.getContract("BlockHistory");

    await deploy("AttendanceArtifact", {
        from: deployer,
        args: [reliquary.address],
        log: true,
        skipIfAlreadyDeployed: true,
    });
    const token = await ethers.getContract("AttendanceArtifact");

    await deploy("AttendanceProver", {
        from: deployer,
        args: [reliquary.address, token.address],
        log: true,
    });
};

module.exports.tags = ["Attendance"];
module.exports.dependencies = ["Reliquary"];
