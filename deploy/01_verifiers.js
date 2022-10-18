const fetch = require('node-fetch');
const { config, ethers } = require("hardhat");

module.exports = async ({getNamedAccounts, deployments}) => {
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    const PROVER_URL = process.env.PROVER_URL;
    if (PROVER_URL === undefined || PROVER_URL.length == 0) {
        throw "PROVER_URL not set";
    }
    let resp = await fetch(`${PROVER_URL}/manifest.json`);
    if (resp.status != 200) {
        throw `Couldn't fetch ${PROVER_URL}/manifest.json`;
    }

    // deploy all the verifiers
    const sizes = config.relic.vkSizes;
    for (var i = 0; i < sizes.length; i++) {
        let vkSize = sizes[i] / 16;
        let resp = await fetch(`${PROVER_URL}/rendered-vk-outer-${vkSize}`);
        let vkRaw = new Uint8Array(await resp.arrayBuffer());
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
        });
    }
};
module.exports.tags = ["Verifiers"];
