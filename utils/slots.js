const { ethers } = require("hardhat")

function getMerkleRootsSlot(blockHistory) {
    const storage = blockHistory.storageLayout.storage.find(({ label }) => label == "merkleRoots")
    const merkleRootsSlot = ethers.utils.defaultAbiCoder.encode(["uint256"], [storage.slot])
    return merkleRootsSlot
}

module.exports = {
    getMerkleRootsSlot
}
