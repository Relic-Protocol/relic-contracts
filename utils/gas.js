const { ethers } = require("hardhat");

const GWEI = ethers.BigNumber.from("1000000000");

const MAX_GAS_PRICE = process.env.MAX_GAS_PRICE;

function getGasOptions() {
    if (MAX_GAS_PRICE === undefined) return {};
    const defaultPriority = GWEI;
    const maxFeePerGas = ethers.BigNumber.from(MAX_GAS_PRICE);
    const maxPriorityFeePerGas = maxFeePerGas.lt(defaultPriority) ? maxFeePerGas : defaultPriority;
    return { maxFeePerGas, maxPriorityFeePerGas };
}

module.exports = {
    getGasOptions
}
