const { config, companionNetworks, network } = require("hardhat");
const { getMerkleRootsSlot } = require("../utils/slots");
const { getMessengerName } = require("../utils/importL2");
const { getL1Contract } = require("../utils/network");

module.exports = async ({getNamedAccounts, deployments}) => {
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    const Reliquary = await deployments.get("Reliquary");
    let skipIfAlreadyDeployed = true;
    if (network.config.bridged === true) {
        if (network.config.zksync === true) {
            const messenger = await getL1Contract(getMessengerName())
            const l1BlockHistory = await companionNetworks["l1"].deployments.get("LegacyBlockHistory")
            const merkleRootsSlot = getMerkleRootsSlot(l1BlockHistory)
            await deploy("BlockHistory", {
                contract: "ZkSyncProxyBlockHistory",
                from: deployer,
                args: [Reliquary.address, messenger.address, l1BlockHistory.address, merkleRootsSlot],
                log: true,
                skipIfAlreadyDeployed,
            });

            let legacyBlockHistory = await deployments.get("BlockHistory")
            if (legacyBlockHistory.devdoc.title.includes("Beacon")) {
                legacyBlockHistory = await deployments.get("LegacyBlockHistory")
            } else {
                deployments.save("LegacyBlockHistory", legacyBlockHistory);
            }

            let l1NetworkName = await companionNetworks["l1"].deployments.getNetworkName();
            let l1NetworkConfig = config.networks[l1NetworkName];
            await deploy("BlockHistory", {
                contract: "ZkSyncProxyBeaconBlockHistory",
                from: deployer,
                args: [
                    messenger.address,
                    Reliquary.address,
                    legacyBlockHistory.address,
                    l1NetworkConfig.capellaSlot,
                    l1NetworkConfig.denebSlot,
                    l1NetworkConfig.upgradeBlock
                ],
                log: true,
            });
        } else if (network.config.optimism === true) {
            const messenger = await getL1Contract(getMessengerName())
            const l1BlockHistory = await companionNetworks["l1"].deployments.get("LegacyBlockHistory")
            const merkleRootsSlot = getMerkleRootsSlot(l1BlockHistory)
            await deploy("BlockHistory", {
                contract: "OptimismProxyBlockHistory",
                from: deployer,
                args: [Reliquary.address, messenger.address, l1BlockHistory.address, merkleRootsSlot],
                log: true,
                skipIfAlreadyDeployed,
            });

            // save and/or rename the BlockHistory deployment as LegacyBlockHistory
            let legacyBlockHistory = await deployments.get("BlockHistory")
            if (legacyBlockHistory.devdoc.title.includes("Beacon")) {
                legacyBlockHistory = await deployments.get("LegacyBlockHistory")
            } else {
                deployments.save("LegacyBlockHistory", legacyBlockHistory);
            }

            let l1NetworkName = await companionNetworks["l1"].deployments.getNetworkName();
            let l1NetworkConfig = config.networks[l1NetworkName];
            await deploy("BlockHistory", {
                contract: "OptimismProxyBeaconBlockHistory",
                from: deployer,
                args: [
                    messenger.address,
                    Reliquary.address,
                    legacyBlockHistory.address,
                    l1NetworkConfig.capellaSlot,
                    l1NetworkConfig.denebSlot,
                    l1NetworkConfig.upgradeBlock
                ],
                log: true,
            });
        }
    } else if (network.config.l2Native === true) {
        // no verifiers on native L2 deployments, only use precomitted blocks
        const sizes = [];
        const verifiers = [];

        // point to the deployed MultiStorageSlotProver on this network for the L1 data
        const proxyProver = await companionNetworks['proxy'].deployments.get("MultiStorageSlotProver")

        // gather necessary information from the 'L2OutputOracle' contract on L1
        const l2OutputOracle = new ethers.Contract(
            network.config.l2OutputOracle,
            [
                'function FINALIZATION_PERIOD_SECONDS() external view returns (uint256)',
                'function getL2Output(uint256) external view returns (bytes32, uint128, uint128)'
            ],
            new ethers.providers.JsonRpcProvider(
                config.networks[companionNetworks['l1'].deployments.getNetworkName()].url
            )
        )
        const blockTag = await l2OutputOracle.provider.getBlock().then(b => b.hash)
        const finalizationPeriodSeconds = await l2OutputOracle.FINALIZATION_PERIOD_SECONDS({blockTag})
        const [output0] = await l2OutputOracle.getL2Output(0, {blockTag})

        // find outputRoots slot
        var outputRootsSlot;
        for (outputRootsSlot = 0; ; outputRootsSlot++) {
            const slotVal = await l2OutputOracle.provider.getStorageAt(
                l2OutputOracle.address,
                ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256'], [outputRootsSlot])),
                blockTag
            )
            if (slotVal == output0) break
            if (outputRootsSlot > 128) throw Error("couldn't find output slot")
        }
        outputRootsSlot = ethers.utils.defaultAbiCoder.encode(['uint256'], [outputRootsSlot])

        await deploy("BlockHistory", {
            contract: "OptimismNativeBlockHistory",
            from: deployer,
            args: [
                sizes,
                verifiers,
                Reliquary.address,
                proxyProver.address,
                l2OutputOracle.address,
                outputRootsSlot,
                finalizationPeriodSeconds
            ],
            log: true,
            skipIfAlreadyDeployed,
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
            skipIfAlreadyDeployed,
        });

        let legacyBlockHistory = await deployments.get("BlockHistory")
        if (legacyBlockHistory.devdoc.title.includes("Beacon")) {
            blockHistory = await deployments.get("LegacyBlockHistory")
        } else {
            deployments.save("LegacyBlockHistory", legacyBlockHistory);
        }

        await deploy("BlockHistory", {
            contract: "BeaconBlockHistory",
            from: deployer,
            args: [
                Reliquary.address,
                legacyBlockHistory.address,
                network.config.beaconOracleContract,
                network.config.capellaSlot,
                network.config.denebSlot,
                network.config.upgradeBlock
            ],
            log: true,
        });
    }
};
module.exports.tags = ["BlockHistory"];
let dependencies = ["Reliquary"];
if (network.config.bridged !== true || network.config.l2Native !== true)
    dependencies = dependencies.concat(["Verifiers"]);
module.exports.dependencies = dependencies;
