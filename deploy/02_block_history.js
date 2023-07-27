const { config } = require("hardhat");

module.exports = async ({getNamedAccounts, deployments}) => {
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    const Reliquary = await deployments.get("Reliquary");
    if (network.zksync === true) {
        const messenger = getenv("L1_MESSENGER")
        const l1BlockHistory = getenv("L1_BLOCK_HISTORY")
        const merkleRootsSlot = getenv("L1_MERKLE_ROOTS_SLOT")
        await deploy("BlockHistory", {
            contract: "ZkSyncProxyBlockHistory",
            from: deployer,
            args: [Reliquary.address, messenger, l1BlockHistory, merkleRootsSlot],
            log: true,
            skipIfAlreadyDeployed: true,
        });
    } else {
        const sizes = config.relic.vkSizes;
        const verifiers = await Promise.all(
            sizes.map((size) => deployments.get(`Verifier-${size}`).then(v => v.address))
        );
        await deploy("BlockHistory", {
            from: deployer,
            args: [sizes, verifiers, Reliquary.address],
            log: true,
            skipIfAlreadyDeployed: true,
        });
    }
};
module.exports.tags = ["BlockHistory"];
module.exports.dependencies = ["Reliquary", "Verifiers"];
