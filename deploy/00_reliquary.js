const { artifacts, config, ethers, network, waffle } = require("hardhat");

module.exports = async ({getNamedAccounts, deployments}) => {
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    await deploy("Reliquary", {
        contract: "ReliquaryWithFee",
        from: deployer,
        args: [],
        log: true,
    });
};
module.exports.tags = ["Reliquary"];
