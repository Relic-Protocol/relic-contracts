const { config } = require("hardhat");

module.exports = async ({getNamedAccounts, deployments}) => {
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    const Reliquary = await deployments.get("Reliquary");
    const sizes = config.relic.vkSizes;
    const verifiers = await Promise.all(
        sizes.map((size) => deployments.get(`Verifier-${size}`).then(v => v.address))
    );
    await deploy("BlockHistory", {
        from: deployer,
        args: [sizes, verifiers, Reliquary.address],
        log: true,
    });
};
module.exports.tags = ["BlockHistory"];
module.exports.dependencies = ["Reliquary", "Verifiers"];
