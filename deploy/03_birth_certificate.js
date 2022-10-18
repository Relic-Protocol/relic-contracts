const { ethers } = require("hardhat");

module.exports = async ({getNamedAccounts, deployments}) => {
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    const reliquary = await ethers.getContract("Reliquary");
    const blockHistory = await ethers.getContract("BlockHistory");

    await deploy("BirthCertificateRelic", {
        from: deployer,
        args: [reliquary.address],
        log: true,
    });
    const token = await ethers.getContract("BirthCertificateRelic");

    await deploy("BirthCertificateProver", {
        from: deployer,
        args: [blockHistory.address, reliquary.address, token.address],
        log: true,
    });
};

module.exports.tags = ["BirthCertificate"];
module.exports.dependencies = ["Reliquary", "BlockHistory"];
