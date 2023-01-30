const fetch = require('node-fetch');
const { config, ethers } = require("hardhat");
const { readFileSync } = require("fs");

module.exports = async ({getNamedAccounts, deployments}) => {
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();

    // deploy all the verifiers
    const sizes = config.relic.vkSizes;
    for (var i = 0; i < sizes.length; i++) {
        let vkSize = sizes[i] / 16;
        let vkRaw = readFileSync(`test/data/rendered-vk-outer-${sizes[i] / 16}`);
        const VK_LENGTH = 35;
        if (vkRaw.length != VK_LENGTH * 32) {
            throw `rendered-vk-outer-${vkSize} has incorret size`;
        }

        // convert vk to uint256[VK_LENGTH]
        let vk = [];
        for (var j = 0; j < VK_LENGTH; j++) {
            vk.push(ethers.BigNumber.from(vkRaw.slice(j * 32, j * 32 + 32)));
        }

        await deploy(`Verifier-${sizes[i]}`, {
            contract: "Verifier",
            from: deployer,
            args: [vk],
            log: true,
            skipIfAlreadyDeployed: true,
        });
    }
};
module.exports.tags = ["Verifiers"];
