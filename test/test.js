const { expect } = require("chai");
const { sign } = require("crypto");
const { hexlify, defaultAbiCoder, keccak256 } = require("ethers/lib/utils");
const { artifacts, config, ethers, network, waffle } = require("hardhat");
const { loadFixture, solidity } = waffle;
const { readFileSync } = require("fs");
const RLP = require("rlp");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const sqlite3 = require("sqlite3");

const {
    buildMerkleRoot, buildMerkleProof, validMerkleProof,
    encodeValidBlockMerkleProof, encodeValidBlockSNARKProof,
    signProof, headerRlp
} = require("../utils/blockproof");

const ZERO_ADDR = "0x" + "0".repeat(40);
const addr0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const addr1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const factsig0 = "0x012345";
const factsig1 = "0x012346";

const eventId = 1;
const chainId = 31337; // idk why but fetching this dynamically is failing

const fee0 = 1_000_000_000;
const BIG_FEE = ethers.BigNumber.from("1000000000000000000");

function getFactStorageSlot(addr, factSig) {
    // 4th slot map(address => map(bytes32 => bytes))
    const abi = new ethers.utils.AbiCoder();

    return ethers.BigNumber.from(
        keccak256(ethers.utils.concat([
            abi.encode(["bytes32"], [factSig]),
            keccak256(abi.encode(["address", "uint256"], [addr, 5]))
        ]))
    ).add(0).toHexString();
}

async function cheatReadFact(contract, addr, factSig) {
    let slot = getFactStorageSlot(addr, factSig);

    return await network.provider.send("eth_getStorageAt", [contract.address, slot]);
}

async function cheatWriteFact(contract, addr, factSig, factData) {
    let slot = getFactStorageSlot(addr, factSig);

    await network.provider.send("hardhat_setStorageAt", [contract.address, slot, factData]);
}

function range(N) {
    return [...new Array(N).keys()]
}

function prefixAll(list) {
    for (var i = 0; i < list.length; i++) {
        if (!list[i].startsWith('0x')) {
            list[i] = '0x' + list[i]
        }
    }
}

const MERKLE_TREE_DEPTH = 13;
const PROOF_DEPTH = 15;


const forkBlock = config.networks.hardhat.forking.blockNumber;
const endBlockNum = forkBlock - 1;
const startBlockNum = endBlockNum + 1 - 2 ** PROOF_DEPTH;

const firstDB = new sqlite3.Database('./test/data/proofs-first.db');
const lastDB = new sqlite3.Database('./test/data/proofs-last.db');

/*
function addBlocks(db, base, num) {
    for (var i = base; i < base + num; i++) {
        let hash = keccak256(readFileSync(`/home/user/proof/blocks/${i}`));
        let sql = "insert into blocks (num, hash) values (?,?)"
        db.run(sql, [i, hash]);
    }
}
addBlocks(lastDB, startBlockNum, 2**PROOF_DEPTH);
addBlocks(firstDB, 0, 2**PROOF_DEPTH);
*/

function getBlockHash(num) {
    expect(
        (num >= startBlockNum && num <= endBlockNum) ||
        (num >= 0 && num <= 2 ** PROOF_DEPTH)
    ).to.equal(true);
    let db = num >= startBlockNum ? lastDB : firstDB;
    let sql = `select hash from blocks where num = (?)`;
    return new Promise((res, rej) => {
        db.get(sql, [num], (err, row) => {
            if (err) rej(err);
            res(row.hash);
        })
    })
}


function loadProof(startBlock, endBlock) {
    let numBlocks = endBlock - startBlock + 1;
    expect(numBlocks % 16).to.equal(0);
    let size = numBlocks / 16;
    let circuit_type = `outer_${size}`;
    let idx = (startBlock % 2 ** 15) / numBlocks;
    let db = startBlock >= startBlockNum ? lastDB : firstDB;
    let sql = `select calldata from proofs where circuit_type = (?) and idx = (?)`;
    return new Promise((res, rej) => {
        db.get(sql, [circuit_type, idx], (err, row) => {
            if (err) rej(err);
            let [numProofs, _, inputs, base, subproofLimbs] = JSON.parse(row.calldata);
            prefixAll(inputs);
            prefixAll(base);
            prefixAll(subproofLimbs);
            res({ base, subproofLimbs, inputs });
        })
    })
}

// must run first because we rely on the hardhat fork block being recent
describe("Blocks", function () {
    async function fixture(_wallets, _provider) {
        const sizes = config.relic.vkSizes;
        let verifiers = [];
        for (var i = 0; i < sizes.length; i++) {
            let vkRaw = readFileSync(`test/data/rendered-vk-outer-${sizes[i] / 16}`);
            const [vk] = defaultAbiCoder.decode(["uint256[35]"], vkRaw);
            const Verifier = await ethers.getContractFactory("Verifier");
            const verifier = await Verifier.deploy(vk);
            await verifier.deployed();
            verifiers.push(verifier.address);
        }

        const BlockHistory = await ethers.getContractFactory("BlockHistoryForTesting");
        const blockHistory = await BlockHistory.deploy(sizes, verifiers, ZERO_ADDR);
        await blockHistory.deployed();

        return { blockHistory };
    }

    it("test blockHistory", async function () {
        const { blockHistory } = await loadFixture(fixture);

        let hashes = [];

        console.log("building proof of most recent blocks...");

        // first gather all the hashes and compute the merkle roots
        const numRoots = 2 ** PROOF_DEPTH / 2 ** MERKLE_TREE_DEPTH;
        let lastRoots = await Promise.all(range(numRoots).map(async (i) => {
            hashes[i] = await Promise.all(range(2 ** MERKLE_TREE_DEPTH).map(async (j) => {
                let num = startBlockNum + i * 2 ** MERKLE_TREE_DEPTH + j;
                let hash = (await getBlockHash(num));
                return hash;
            }));
            return buildMerkleRoot(hashes[i]);
        }));

        let lastProof = await loadProof(startBlockNum, endBlockNum);

        // test proving a block by providing a snark
        let idx = 2 ** (PROOF_DEPTH - 1);
        let allHashes = new Array().concat(...hashes);
        let proof = await encodeValidBlockSNARKProof(
            null, true, 2 ** PROOF_DEPTH, endBlockNum, lastProof, buildMerkleProof(allHashes, idx)
        );
        expect(
            await blockHistory.connect(ethers.provider).validBlockHash(allHashes[idx], startBlockNum + idx, proof, { from: ZERO_ADDR })
        ).to.equal(true);

        // prove the last chunk of blocks
        await expect(
            blockHistory.importLast(endBlockNum, [lastProof, "0x"], lastRoots, "0x")
        ).to.emit(blockHistory, "ImportMerkleRoot");

        // verify merkle proofs
        console.log("verifying some merkle proofs...");
        let verifyAmt = 100 / 2 ** PROOF_DEPTH // only verify ~ 100 random proofs
        await Promise.all(range(2 ** PROOF_DEPTH).filter(() => Math.random() < verifyAmt).map(async (idx) => {
            let [i, j] = [Math.floor(idx / 2 ** MERKLE_TREE_DEPTH), idx % 2 ** MERKLE_TREE_DEPTH];
            let merkleProof = encodeValidBlockMerkleProof(true, buildMerkleProof(hashes[i], j));
            await blockHistory.assertValidBlockHashForTesting(hashes[i][j], startBlockNum + idx, merkleProof);
        }));

        // simulate proving all blocks in between
        let parentHash = await getBlockHash(2 ** PROOF_DEPTH - 1);
        await blockHistory.setHashesForTesting(parentHash, await blockHistory.lastHash());
        await blockHistory.setEarliestRootForTesting(2**(PROOF_DEPTH  - MERKLE_TREE_DEPTH));

        // prove the first chunk of blocks
        console.log("building proof of oldest blocks...");
        let firstRoots = await Promise.all(range(numRoots).map(async (i) => {
            hashes[i] = await Promise.all(range(2 ** MERKLE_TREE_DEPTH).map(async (j) => {
                let num = i * 2 ** MERKLE_TREE_DEPTH + j;
                let hash = await getBlockHash(num);
                return hash;
            }));
            return buildMerkleRoot(hashes[i]);
        }));
        let firstProof = await loadProof(0, 2 ** PROOF_DEPTH - 1);

        await expect(
            blockHistory.importParent([firstProof, "0x"], firstRoots)
        ).to.emit(blockHistory, "ImportMerkleRoot");

        expect(await blockHistory.parentHash()).to.equal("0x0000000000000000000000000000000000000000000000000000000000000000");

        // verify merkle proofs for first blocks
        console.log("verifying some merkle proofs...");
        await Promise.all(range(2 ** PROOF_DEPTH).filter(() => Math.random() < verifyAmt).map(async (idx) => {
            let [i, j] = [Math.floor(idx / 2 ** MERKLE_TREE_DEPTH), idx % 2 ** MERKLE_TREE_DEPTH];
            let merkleProof = encodeValidBlockMerkleProof(true, buildMerkleProof(hashes[i], j));
            await blockHistory.assertValidBlockHashForTesting(hashes[i][j], idx, merkleProof);
        }));
        let merkleProof = encodeValidBlockMerkleProof(true, buildMerkleProof(hashes[0], 0));
        expect(
            await blockHistory.connect(ethers.provider).validBlockHash(hashes[0][0], 0, merkleProof, { from: ZERO_ADDR })
        ).to.equal(true);

        // bump the lastHash backwards to allow testing importLast
        let fakeLastHash = (await ethers.provider.getBlock(startBlockNum - 1)).hash;
        await blockHistory.setHashesForTesting(await blockHistory.parentHash(), fakeLastHash);

        console.log("testing importLast...");
        await expect(
            blockHistory.importLast(endBlockNum, [lastProof, "0x"], lastRoots, "0x")
        ).to.emit(blockHistory, "ImportMerkleRoot");

        let signer = await ethers.getSigner(addr0);
        await expect(blockHistory.setSigner(addr0)).to.emit(blockHistory, "NewSigner");

        // reset the hashes to do importLast again
        await blockHistory.setHashesForTesting(await blockHistory.parentHash(), fakeLastHash);

        console.log("testing importLast with signature...");
        await expect(
            // no signature should now fail
            blockHistory.importLast(endBlockNum, [lastProof, "0x"], lastRoots, "0x")
        ).to.be.revertedWith("ECDSA: invalid signature length");

        await expect(
            // sign the wrong proof, should fail
            blockHistory.importLast(endBlockNum, [lastProof, await signProof(signer, firstProof)], lastRoots, "0x")
        ).to.be.revertedWith("invalid SNARK");

        await expect(
            // correct signature, should work
            blockHistory.importLast(endBlockNum, [lastProof, await signProof(signer, lastProof)], lastRoots, "0x")
        ).to.emit(blockHistory, "ImportMerkleRoot");

        // remove the signer now
        await expect(blockHistory.setSigner(ZERO_ADDR)).to.emit(blockHistory, "NewSigner");

        // reset the hashes to do importLast again
        await blockHistory.setHashesForTesting(await blockHistory.parentHash(), fakeLastHash);

        // test importLast with connectProof
        let middle = startBlockNum + 2 ** (PROOF_DEPTH - 1);
        let lastProof0 = await loadProof(startBlockNum, middle - 1);
        let lastProof1 = await loadProof(middle, endBlockNum);
        let lastRoots0 = lastRoots.slice(0, lastRoots.length / 2);
        let connectProof = await encodeValidBlockSNARKProof(
            // merkle proof not needed since we're targeting the proof's parentHash
            null, false, 2 ** (PROOF_DEPTH - 1), endBlockNum, lastProof1, []
        );
        await blockHistory.importLast(middle - 1, [lastProof0, "0x"], lastRoots0, connectProof);
        expect(await blockHistory.lastHash()).to.equal(await getBlockHash(middle - 1));
    })
})

describe("Reliquary", function () {
    const MERKLE_TREE_DEPTH = 13;
    const BLOCKS_PER_CHUNK = 2 ** MERKLE_TREE_DEPTH;
    const targetBlock = config.networks.hardhat.forking.blockNumber - BLOCKS_PER_CHUNK;
    expect(targetBlock % BLOCKS_PER_CHUNK).to.equal(0);
    const preByzantiumBlock = 4369999;

    async function fixture(_wallets, _provider) {
        const Reliquary = await ethers.getContractFactory("ReliquaryWithFee");
        const reliquary = await Reliquary.deploy();
        await reliquary.deployed();

        const MockToken = await ethers.getContractFactory("MockRelic");
        const mockToken = await MockToken.deploy(0, factsig0, reliquary.address);
        await mockToken.deployed();

        const MockProver = await ethers.getContractFactory("MockProver");
        const mockProver = await MockProver.deploy(0, factsig0, reliquary.address, mockToken.address);
        await mockProver.deployed();

        let tx = await mockToken.setProver(mockProver.address, true);
        await tx.wait();

        const URIer = await ethers.getContractFactory("MockTokenURI");
        const urier = await URIer.deploy();
        await urier.deployed();

        const AToken = await ethers.getContractFactory("AttendanceArtifact");
        const aToken = await AToken.deploy(reliquary.address);
        await aToken.deployed();

        const AProver = await ethers.getContractFactory("AttendanceProver");
        const aProver = await AProver.deploy(reliquary.address, aToken.address);
        await aProver.deployed();

        tx = await aProver.setOuterSigner(addr0);
        await tx.wait();

        tx = await aToken.setProver(aProver.address, true);
        await tx.wait();

        let block = await ethers.provider.getBlock("latest")
        tx = await aProver.addEvent(eventId, addr0, block.timestamp + 7 * 24 * 3600, 1000);
        await tx.wait();

        // deploy BlockHistory with no verifiers, use the *ForTesting functions
        const BlockHistory = await ethers.getContractFactory("BlockHistoryForTesting");
        const blockHistory = await BlockHistory.deploy([], [], reliquary.address);
        await blockHistory.deployed();

        // setup merkle root and proof for testing
        block = await ethers.provider.getBlock(targetBlock);

        // real hashes for targetBlock ... targetBlock+2; fake hashes for rest
        let hashes = new Array(BLOCKS_PER_CHUNK).fill(block.hash);
        hashes[1] = (await ethers.provider.getBlock(targetBlock + 1)).hash;
        hashes[2] = (await ethers.provider.getBlock(targetBlock + 2)).hash;
        const root = buildMerkleRoot(hashes);

        block = await ethers.provider.getBlock(preByzantiumBlock);
        // real hashes for preByzantiumBlock; fake hashes for rest
        let preByzantiumHashes = new Array(BLOCKS_PER_CHUNK).fill(block.hash);
        const preByzantiumRoot = buildMerkleRoot(preByzantiumHashes);

        // setup merkle roots used in tests
        tx = await blockHistory.storeMerkleRootsForTesting(targetBlock / BLOCKS_PER_CHUNK, [root]);
        await tx.wait()

        tx = await blockHistory.storeMerkleRootsForTesting(Math.floor(preByzantiumBlock / BLOCKS_PER_CHUNK), [preByzantiumRoot]);
        await tx.wait()

        const BCToken = await ethers.getContractFactory("BirthCertificateRelic");
        const bcToken = await BCToken.deploy(reliquary.address);
        await bcToken.deployed();

        const BCProver = await ethers.getContractFactory("BirthCertificateProver");
        const bcProver = await BCProver.deploy(blockHistory.address, reliquary.address, bcToken.address);
        await bcProver.deployed();

        tx = await bcToken.setProver(bcProver.address, true);
        await tx.wait();

        const SSProver = await ethers.getContractFactory("StorageSlotProver");
        const ssProver = await SSProver.deploy(blockHistory.address, reliquary.address);
        await ssProver.deployed();

        const LProver = await ethers.getContractFactory("LogProver");
        const lProver = await LProver.deploy(blockHistory.address, reliquary.address);
        await lProver.deployed();

        const BHProver = await ethers.getContractFactory("BlockHeaderProver");
        const bhProver = await BHProver.deploy(blockHistory.address, reliquary.address);
        await bhProver.deployed();

        async function getBlockHeader(blockNum) {
            const rawHeader = await ethers.provider.send("eth_getBlockByNumber", ["0x" + blockNum.toString(16), false]);
            return headerRlp(rawHeader);
        }

        const CSSProver = await ethers.getContractFactory("CachedStorageSlotProver");
        const cssProver = await CSSProver.deploy(blockHistory.address, reliquary.address);
        await cssProver.deployed();

        const ASProver = await ethers.getContractFactory("AccountStorageProver");
        const asProver = await ASProver.deploy(blockHistory.address, reliquary.address);
        await asProver.deployed();

        const MSSProver = await ethers.getContractFactory("MultiStorageSlotProver");
        const mssProver = await MSSProver.deploy(blockHistory.address, reliquary.address);
        await mssProver.deployed();

        async function getProofs(blockNum, account, slots, concatSlots = true) {
            // use the base provider to fetch trie proofs, because hardhat doesn't support it
            const baseProvider = new ethers.providers.JsonRpcProvider(config.networks.hardhat.forking.url);
            const formatted = slots.map(s => defaultAbiCoder.encode(["uint256"], [s]));
            const res = await baseProvider.send("eth_getProof", [account, formatted, "0x" + blockNum.toString(16)]);

            // concatenate proof nodes
            const accountProof = ethers.utils.concat(res.accountProof);

            let blockProof;
            if (blockNum >= targetBlock) {
                blockProof = encodeValidBlockMerkleProof(true, buildMerkleProof(hashes, blockNum - targetBlock));
            } else if (blockNum == preByzantiumBlock) {
                blockProof = encodeValidBlockMerkleProof(true, buildMerkleProof(preByzantiumHashes, preByzantiumBlock % BLOCKS_PER_CHUNK));
            }
            let slotProofs = {};
            let accountRoot = undefined;
            res.storageProof.forEach((sp) => {
                if (sp.proof.length > 0) {
                    accountRoot = keccak256(res.storageProof[0].proof[0]);
                } else {
                    accountRoot = keccak256("0x");
                }
                if (concatSlots)
                    slotProofs[sp.key] = ethers.utils.concat(sp.proof);
                else
                    slotProofs[sp.key] = sp.proof
            });
            const headerRLP = await getBlockHeader(blockNum);

            return {accountProof, headerRLP, blockProof, accountRoot, slotProofs};
        }
        return { reliquary, blockHistory, mockToken, mockProver, aToken, aProver, bcToken, bcProver, ssProver, lProver, bhProver, cssProver, asProver, mssProver, urier, getBlockHeader, getProofs };
    }

    async function fixtureAddProverValid(_wallets, _provider) {
        const { reliquary, blockHistory, mockToken, mockProver, aToken, aProver, bcToken, bcProver, ssProver, lProver, bhProver, cssProver, asProver, mssProver, urier, getBlockHeader, getProofs } = await loadFixture(fixture);

        await reliquary.grantRole(await reliquary.ADD_PROVER_ROLE(), addr0);

        let tx = await reliquary.addProver(mockProver.address, 1);
        let receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");
        tx = await reliquary.activateProver(mockProver.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("NewProver");

        tx = await reliquary.addProver(aProver.address, 2);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");
        tx = await reliquary.activateProver(aProver.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("NewProver");

        tx = await reliquary.setInitialized();
        await tx.wait();

        // now provers should become pending
        tx = await reliquary.addProver(bcProver.address, 3);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");

        tx = await reliquary.addProver(ssProver.address, 4);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");

        tx = await reliquary.addProver(lProver.address, 5);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");

        tx = await reliquary.addProver(bhProver.address, 6);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");

        tx = await reliquary.addProver(cssProver.address, 7);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");

        tx = await reliquary.addProver(asProver.address, 8);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");

        tx = await reliquary.addProver(mssProver.address, 9);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");

        await expect(
            reliquary.activateProver(bcProver.address)
        ).to.be.revertedWith("not ready");

        await helpers.time.increase(2 * 24 * 3600);
        await expect(
            reliquary.activateProver(mockProver.address)
        ).to.be.revertedWith("duplicate prover");

        tx = await reliquary.activateProver(bcProver.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("NewProver");

        tx = await reliquary.activateProver(ssProver.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("NewProver");

        tx = await reliquary.activateProver(lProver.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("NewProver");

        tx = await reliquary.activateProver(bhProver.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("NewProver");

        tx = await reliquary.activateProver(cssProver.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("NewProver");

        tx = await reliquary.activateProver(asProver.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("NewProver");

        tx = await reliquary.activateProver(mssProver.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("NewProver");

        await reliquary.grantRole(await reliquary.GOVERNANCE_ROLE(), addr0);

        await reliquary.setProverFee(mockProver.address, {
            flags: 0x1, // none
            feeCredits: 0,
            feeWeiMantissa: 0,
            feeWeiExponent: 0,
            feeExternalId: 0
        }, ZERO_ADDR)

        await reliquary.setProverFee(aProver.address, {
            flags: 0x1, // none
            feeCredits: 0,
            feeWeiMantissa: 0,
            feeWeiExponent: 0,
            feeExternalId: 0
        }, ZERO_ADDR)

        await reliquary.setProverFee(bcProver.address, {
            flags: 0x1, // none
            feeCredits: 0,
            feeWeiMantissa: 0,
            feeWeiExponent: 0,
            feeExternalId: 0
        }, ZERO_ADDR)

        await reliquary.setProverFee(ssProver.address, {
            flags: 0x1, // none
            feeCredits: 0,
            feeWeiMantissa: 0,
            feeWeiExponent: 0,
            feeExternalId: 0
        }, ZERO_ADDR)

        await reliquary.setProverFee(lProver.address, {
            flags: 0x1, // none
            feeCredits: 0,
            feeWeiMantissa: 0,
            feeWeiExponent: 0,
            feeExternalId: 0
        }, ZERO_ADDR)

        await reliquary.setProverFee(bhProver.address, {
            flags: 0x1, // none
            feeCredits: 0,
            feeWeiMantissa: 0,
            feeWeiExponent: 0,
            feeExternalId: 0
        }, ZERO_ADDR)

        await reliquary.setProverFee(cssProver.address, {
            flags: 0x1, // none
            feeCredits: 0,
            feeWeiMantissa: 0,
            feeWeiExponent: 0,
            feeExternalId: 0
        }, ZERO_ADDR)

        await reliquary.setProverFee(asProver.address, {
            flags: 0x1, // none
            feeCredits: 0,
            feeWeiMantissa: 0,
            feeWeiExponent: 0,
            feeExternalId: 0
        }, ZERO_ADDR)

        await reliquary.setProverFee(mssProver.address, {
            flags: 0x1, // none
            feeCredits: 0,
            feeWeiMantissa: 0,
            feeWeiExponent: 0,
            feeExternalId: 0
        }, ZERO_ADDR)

        return { reliquary, blockHistory, mockToken, mockProver, aToken, aProver, bcToken, bcProver, ssProver, lProver, bhProver, cssProver, asProver, mssProver, urier, getBlockHeader, getProofs };
    }

    async function fixtureAddProverShortWait(_wallets, _provider) {
        const { reliquary, mockToken, mockProver } = await loadFixture(fixture);
        await reliquary.grantRole(await reliquary.ADD_PROVER_ROLE(), addr0);

        let tx = await reliquary.setInitialized();
        await tx.wait();

        tx = await reliquary.addProver(mockProver.address, 1);
        let receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");

        await helpers.time.increase(8 * 3600);
        await expect(
            reliquary.activateProver(mockProver.address)
        ).to.be.revertedWith("not ready");

        return { reliquary, mockToken, mockProver };
    }

    async function fixtureEphemeralFacts(_wallets, _provider) {
        const { reliquary, ssProver, lProver, bcProver, getProofs } = await loadFixture(fixtureAddProverValid);

        const EphemeralFacts = await ethers.getContractFactory("EphemeralFacts");
        const ephemeralFacts = await EphemeralFacts.deploy(reliquary.address);
        await ephemeralFacts.deployed();

        const RelicReceiverForTesting = await ethers.getContractFactory("RelicReceiverForTesting");
        const receiver = await RelicReceiverForTesting.deploy(ephemeralFacts.address);
        await receiver.deployed();

        return { reliquary, ssProver, lProver, bcProver, ephemeralFacts, receiver, getProofs };
    }

    it("test bad issuing", async function () {
        const { reliquary, mockToken, mockProver } = await loadFixture(fixtureAddProverShortWait);
        function encodeProof(...args) {
            return defaultAbiCoder.encode(["address", "uint48"], args);
        }
        await expect(mockProver.prove(encodeProof(addr0, 1), true)).to.be.revertedWith("unknown prover");
    })

    it("test reliquary/subscription management", async function () {
        const { reliquary, mockToken, mockProver } = await loadFixture(fixtureAddProverValid);
        function encodeProof(...args) {
            return defaultAbiCoder.encode(["address", "uint48"], args);
        }

        await expect(
            reliquary.addProver(mockProver.address, 1)
        ).to.be.revertedWith("duplicate version");
        await expect(
            reliquary.addProver(mockProver.address, 1337)
        ).to.be.revertedWith("duplicate prover");


        const factCls = 1;
        const MockProver = await ethers.getContractFactory("MockProver");
        const mockProver2 = await MockProver.deploy(factCls, factsig0, reliquary.address, mockToken.address);
        await mockProver2.deployed();

        let tx = await reliquary.addProver(mockProver2.address, 1337);
        let receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");

        await helpers.time.increase(2 * 24 * 3600);

        // should be ready now
        tx = await reliquary.activateProver(mockProver2.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("NewProver");

        // test prover fee
        await expect(
            mockProver2.prove(encodeProof(addr0, 1), false)
        ).to.be.revertedWith("insufficient fee");
        await reliquary.setProverFee(mockProver2.address, {
            flags: 0x1, // none
            feeCredits: 0,
            feeWeiMantissa: 0,
            feeWeiExponent: 0,
            feeExternalId: 0,
        }, ZERO_ADDR);
        await expect(
            reliquary.getProveFactNativeFee(mockProver2.address)
        ).to.be.reverted;
        await expect(
            reliquary.getProveFactTokenFee(mockProver2.address)
        ).to.be.reverted;

        // proofs are fine
        await mockProver2.prove(encodeProof(addr0, 1), false);

        // test subscription
        await reliquary.grantRole(await reliquary.SUBSCRIPTION_ROLE(), addr0);

        const factSig = await mockProver2.factSig();
        await reliquary.setFactFee(factCls, {
            flags: 0x6, // native | credits
            feeCredits: 2,
            feeWeiMantissa: 1, // 0.1 ETH
            feeWeiExponent: 17,
            feeExternalId: 0, // unused
        }, ZERO_ADDR);

        expect(await reliquary.getVerifyFactNativeFee(factSig)).to.equal(ethers.BigNumber.from("100000000000000000"));
        await expect(
            reliquary.getVerifyFactTokenFee(factSig)
        ).to.be.reverted;

        await expect(
            reliquary.verifyFact(addr0, factSig)
        ).to.be.revertedWith("insufficient fee");

        await reliquary.addSubscriber(addr0, 0xffffffff);
        expect(await reliquary.isSubscriber(addr0)).to.equal(true);
        await reliquary.verifyFact(addr0, factSig);

        await reliquary.removeSubscriber(addr0);
        await expect(
            reliquary.verifyFact(addr0, factSig)
        ).to.be.revertedWith("insufficient fee");

        // test native fees
        await reliquary.verifyFact(addr0, factSig, { value: await reliquary.getVerifyFactNativeFee(factSig) });
        await expect(
            reliquary.verifyFact(addr0, factSig, { value: ethers.BigNumber.from("90000000000000000") })
        ).to.be.revertedWith("insufficient fee");

        {
            const balanceBefore = await ethers.provider.getBalance(reliquary.address);
            const balanceBeforeDest = await ethers.provider.getBalance(addr1);
            expect(balanceBefore).to.equal(ethers.BigNumber.from("100000000000000000"));
            await reliquary.withdrawFees(ZERO_ADDR, addr1);
            expect(await ethers.provider.getBalance(reliquary.address)).to.equal(ethers.BigNumber.from("0"));
            expect(await ethers.provider.getBalance(addr1)).to.equal(balanceBeforeDest.add(balanceBefore));
        }

        // test credits
        await reliquary.grantRole(await reliquary.CREDITS_ROLE(), addr0);

        await reliquary.addCredits(addr0, 3);
        reliquary.verifyFact(addr0, factSig);
        await expect(
            reliquary.verifyFact(addr0, factSig)
        ).to.be.revertedWith("insufficient fee");
        expect(await reliquary.credits(addr0)).to.equal(ethers.BigNumber.from("1"));

        await reliquary.setCredits(addr0, 11);
        expect(await reliquary.credits(addr0)).to.equal(ethers.BigNumber.from("11"));
        await reliquary.removeCredits(addr0, 2);
        expect(await reliquary.credits(addr0)).to.equal(ethers.BigNumber.from("9"));

        // test external token
        const MockFeeToken = await ethers.getContractFactory("MockERC20");
        const mockFeeToken = await MockFeeToken.deploy();
        await reliquary.setFactFee(factCls, {
            flags: 0x10, // external token
            feeCredits: 0,
            feeWeiMantissa: 1,
            feeWeiExponent: 18,
            feeExternalId: 0
        }, mockFeeToken.address);
        await expect(
            reliquary.verifyFact(addr0, factSig)
        ).to.be.revertedWith("ERC20: insufficient allowance");
        await mockFeeToken.approve(reliquary.address, ethers.BigNumber.from("1000000000000000000"));
        {
            const balanceBefore = await mockFeeToken.balanceOf(addr0);
            await reliquary.verifyFact(addr0, factSig);
            expect(await mockFeeToken.balanceOf(addr0)).to.equal(ethers.BigNumber.from("9000000000000000000"));
        }
        expect(await reliquary.getVerifyFactTokenFee(factSig)).to.equal(ethers.BigNumber.from("1000000000000000000"));
        await reliquary.withdrawFees(mockFeeToken.address, addr1);
        expect(await mockFeeToken.balanceOf(addr1)).to.equal(ethers.BigNumber.from("1000000000000000000"));

        // test external delegate
        const MockFeeDelegate = await ethers.getContractFactory("MockFeeDelegate");
        const mockFeeDelegate = await MockFeeDelegate.deploy();
        await reliquary.setFactFee(factCls, {
            flags: 0x8, // external delegate
            feeCredits: 0,
            feeWeiMantissa: 1,
            feeWeiExponent: 18,
            feeExternalId: 0
        }, mockFeeDelegate.address);
        await expect(
            reliquary.verifyFact(addr0, factSig)
        ).to.be.reverted;
        await expect(
            reliquary.verifyFact(addr0, factSig, { value: ethers.BigNumber.from("10000000000000000") })
        ).to.be.reverted;
        reliquary.verifyFact(addr0, factSig, { value: ethers.BigNumber.from("1000000000000000000") });

        expect(await reliquary.getVerifyFactNativeFee('0x' + '0'.repeat(64))).to.equal(0);
        expect(await reliquary.getVerifyFactTokenFee('0x' + '0'.repeat(64))).to.equal(0);

        // test prover native fee and token fee
        await reliquary.setProverFee(mockProver2.address, {
            flags: 0x12, // token | native
            feeCredits: 0,
            feeWeiMantissa: 2,
            feeWeiExponent: 17,
            feeExternalId: 0,
        }, mockFeeToken.address);
        expect(await reliquary.getProveFactNativeFee(mockProver2.address)).to.equal(ethers.BigNumber.from("200000000000000000"));
        expect(await reliquary.getProveFactTokenFee(mockProver2.address)).to.equal(ethers.BigNumber.from("200000000000000000"));
        await mockProver2.prove(encodeProof(addr0, 2), false, { value: ethers.BigNumber.from("200000000000000000") });

        // test revokation
        tx = await reliquary.revokeProver(mockProver2.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("ProverRevoked");

        await expect(mockProver2.prove(encodeProof(addr0, 2), false)).to.be.revertedWith("revoked prover");
    })

    it("test issuing", async function () {
        const { reliquary, mockToken, mockProver } = await loadFixture(fixtureAddProverValid);
        function encodeProof(...args) {
            return defaultAbiCoder.encode(["address", "uint48"], args);
        }
        let expected = expect(await mockProver.prove(encodeProof(addr0, 1), true));

        // should issue NFT "Transfer" and SBT "Locked"
        await expected.to.emit(mockToken, "Transfer");
        await expected.to.emit(mockToken, "Locked");

        const factsig = await mockProver.factSig();
        tx = await reliquary.verifyFact(addr0, factsig, { value: fee0 });
        receipt = await tx.wait();

        tx = await reliquary.verifyFactVersion(addr0, factsig, { value: fee0 });
        receipt = await tx.wait();

        tx = await mockProver.prove(encodeProof(addr0, 1), true);
        receipt = await tx.wait();
        // should NOT issue NFT "Transfer", they've already got one
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("FactProven");

        // fake issue an invalid fact and ensure we throw properly
        expect(await cheatReadFact(reliquary, addr0, factsig)).not.equal(ethers.utils.hexZeroPad(0, 32))
        await cheatWriteFact(reliquary, addr0, factsig, "0x0000000000000000000000000000000000000000000000000000000000000002");

        await expect(reliquary.verifyFact(addr0, factsig, { value: fee0 })).to.be.revertedWith("fact data length invalid");
    })

    it("test attendance", async function () {
        const { reliquary, mockToken, mockProver, aToken, aProver, bcToken, bcProver, urier } = await loadFixture(fixtureAddProverValid);

        let signer = await ethers.getSigner(addr0);

        async function signMessage(signer1, signer2, chainId, eventId, n, address) {
            let innerSig = await signer1.signMessage(
                ethers.utils.arrayify(
                    defaultAbiCoder.encode(["uint256", "uint64", "uint64"], [chainId, eventId, n])
                )
            );
            let outerSig = await signer2.signMessage(
                ethers.utils.arrayify(
                    innerSig + address.substr(2)
                )
            );
            return { innerSig, outerSig }
        }

        async function signAndClaim(signer1, signer2, chainId, eventId, n, address) {
            let { innerSig, outerSig } = await signMessage(signer1, signer2, chainId, eventId, n, address);
            return aProver.claim(address, eventId, n, innerSig, outerSig);
        }

        let tx = await signAndClaim(signer, signer, chainId, eventId, 0, addr0);
        let receipt = await tx.wait();

        // double claims not allowed
        await expect(
            signAndClaim(signer, signer, chainId, eventId, 0, addr0)
        ).to.be.revertedWith("already claimed");


        tx = await signAndClaim(signer, signer, chainId, eventId, 1, addr0)
        receipt = await tx.wait();

        await expect(
            signAndClaim(signer, signer, chainId, eventId + 13, 0, addr0)
        ).to.be.revertedWith("invalid eventID");


        let badSigner = await ethers.getSigner(addr1);
        await expect(
            signAndClaim(badSigner, signer, chainId, eventId, 2, addr0)
        ).to.be.revertedWith("invalid inner signer");

        await expect(
            signAndClaim(signer, badSigner, chainId, eventId, 2, addr0)
        ).to.be.revertedWith("invalid outer signer");

        tx = await signAndClaim(signer, signer, chainId, eventId, 999, addr0);
        await tx.wait();

        await expect(
            signAndClaim(signer, signer, chainId, eventId, 1022, addr0)
        ).to.be.revertedWith("id exceeds capacity");
        tx = await aProver.increaseCapacity(eventId, 2048);
        await tx.wait();

        await expect(
            signAndClaim(signer, signer, chainId, eventId, 1022, addr0)
        ).to.not.be.reverted;

        await expect(
            signAndClaim(signer, signer, chainId, eventId, 2022, addr0)
        ).to.not.be.reverted;

        await expect(
            signAndClaim(signer, signer, chainId, eventId, 999, addr0)
        ).to.be.revertedWith("already claimed");

        await helpers.time.increase(7 * 24 * 3600);

        await expect(
            signAndClaim(signer, signer, chainId, eventId, 999, addr0)
        ).to.be.revertedWith("claim expired");

        ethers.utils.solidityPack(["uint64", "address"], [eventId, addr0])

        await expect(
            aToken.tokenURI(ethers.utils.solidityPack(["uint64", "address"], [eventId, addr0]))
        ).to.be.revertedWith("uri provider not set");

        await expect(
            aToken.tokenURI(ethers.utils.solidityPack(["uint64", "address"], [eventId + 13, addr0]))
        ).to.be.revertedWith("token does not exist");

        await expect(aToken.addURIProvider(urier.address, eventId)).to.not.be.reverted;

        expect(
            await aToken.tokenURI(ethers.utils.solidityPack(["uint64", "address"], [eventId, addr0]))
        ).contains("data:application/json;base64");

        expect(await aToken.name()).equal("Attendance Artifact");
        expect(await aToken.symbol()).equal("RAA");

        await expect(
            aToken.exchange(ethers.utils.solidityPack(["uint64", "address"], [eventId, addr0]), 1)
        ).to.be.revertedWith("invalid URI provider");

        await expect(
            aToken.exchange(ethers.utils.solidityPack(["uint64", "address"], [eventId, addr1]), 1)
        ).to.be.revertedWith("only token owner may exchange");

        await expect(
            aToken.exchange(ethers.utils.solidityPack(["uint64", "address"], [eventId + 3, addr0]), 1)
        ).to.be.revertedWith("token does not exist");

        await expect(aToken.addURIProvider(urier.address, eventId)).to.not.be.reverted;
        tx = await (
            aToken.exchange(ethers.utils.solidityPack(["uint64", "address"], [eventId, addr0]), 1)
        );
        receipt = await tx.wait();
        expect(receipt.events.length).equals(4);

        // use test vectors generated from relic-web2
        let testId = 9999999
        let testInner = "0xa4dd6f32ef8b86fe4ac07d6df0c2b753eeb2bc2c384fe7a879f7b2bd40b03d6536b0318ef265871faa86bbc7a9c29859068253c7eec64107add072f6df97e6621b";
        let testOuter = "0x841481c7e8d51ab273cf9f4e256b5d04c3d15a7c1173e6c32c7bd8ae835619295f778049c581540065b74f3cc9b15ed48d4f402bd86d27f89a22f0994587cdad1b";
        let proverInner = "0xf0ACba8b1bd62112436C75F0297B7D581992C919";
        let proverOuter = "0x15aA0a32D7ab8Cbcbade50a817c578c23D456717";

        tx = await aProver.setOuterSigner(proverOuter);
        await tx.wait();

        let block = await ethers.provider.getBlock("latest")
        tx = await aProver.addEvent(testId, proverInner, block.timestamp + 30000, 1);
        await tx.wait();

        await expect(
            aProver.claim(addr0, testId, 0, testInner, testOuter)
        ).to.not.be.reverted;
        await expect(
            aProver.claim(addr0, testId, 0, testInner, testOuter)
        ).to.be.revertedWith("already claimed");
    })

    it("test storage slots", async function () {
        const { reliquary, ssProver, getProofs } = await loadFixture(fixtureAddProverValid);

        function encodeProof(...args) {
            return defaultAbiCoder.encode(["address", "bytes", "bytes32", "bytes", "bytes", "bytes"], args);
        }

        const WETH = new ethers.Contract(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            ["function balanceOf(address) view returns (uint256)"],
            ethers.provider
        );

        // compute storage slot of WETH.balanceOf(WETH)
        const BALANCE_MAP = 3;
        const slot = keccak256(defaultAbiCoder.encode(["address", "uint256"], [WETH.address, BALANCE_MAP]));

        // check proving slot works
        let {accountProof, headerRLP, blockProof, slotProofs} = await getProofs(targetBlock, WETH.address, [slot]);
        tx = await ssProver.prove(
            encodeProof(WETH.address, accountProof, slot, slotProofs[slot], headerRLP, blockProof),
            true
        );
        await tx.wait();

        // check proving the wrong account block fails
        const fakeAddr = WETH.address.replace("C", "D").toLowerCase();
        let {} = {accountProof, headerRLP, blockProof, slotProofs} = await getProofs(targetBlock, fakeAddr, [slot]);
        await expect(
            ssProver.prove(encodeProof(WETH.address, accountProof, slot, slotProofs[slot], headerRLP, blockProof), true),
        ).to.be.revertedWith("node hash incorrect");

        // check proving a missing slot succeeds (value should be 0)
        const emptySlot = keccak256(defaultAbiCoder.encode(["address", "uint256"], [fakeAddr, BALANCE_MAP]));
        expect(await WETH.balanceOf(fakeAddr)).to.equal(0);

        let {} = {accountProof, headerRLP, blockProof, slotProofs} = await getProofs(targetBlock, WETH.address, [emptySlot]);
        tx = await ssProver.prove(
            encodeProof(WETH.address, accountProof, emptySlot, slotProofs[emptySlot], headerRLP, blockProof),
            true
        );
        await tx.wait();

        // proving a slot from an empty storage trie should succeed
        const nonContract = "0x0000000000000000000000000000000000000000";
        let {} = {accountProof, headerRLP, blockProof, slotProofs} = await getProofs(targetBlock, nonContract, [slot]);
        tx = await ssProver.prove(
            encodeProof(nonContract, accountProof, slot, slotProofs[slot], headerRLP, blockProof),
            true
        );
        await tx.wait();
    })

    it("test block header prover", async function () {
        function encodeProof(...args) {
            return defaultAbiCoder.encode(["bytes", "bytes"], args)
        }
        const { reliquary, blockHistory, bhProver, getBlockHeader } = await loadFixture(fixtureAddProverValid);

        const blockNum = 1337;

        let hashes = await Promise.all(range(2**MERKLE_TREE_DEPTH).map((i) => getBlockHash(i)));
        let root = buildMerkleRoot(hashes);
        let tx = await blockHistory.storeMerkleRootsForTesting(0, [root]);
        await tx.wait()

        let proof = encodeValidBlockMerkleProof(true, buildMerkleProof(hashes, blockNum));
        let headerRLP = await getBlockHeader(blockNum);

        tx = await bhProver.prove(encodeProof(headerRLP, proof), false);
        await tx.wait();
    })

    it("test cached storage slots", async function () {
        const { reliquary, cssProver, asProver, getProofs } = await loadFixture(fixtureAddProverValid);

        function encodeASProof(...args) {
            return defaultAbiCoder.encode(["address", "bytes", "bytes", "bytes"], args);
        }

        function encodeCSSProof(...args) {
            return defaultAbiCoder.encode(["address", "uint256", "bytes32", "bytes32", "bytes"], args);
        }

        const WETH = new ethers.Contract(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            ["function balanceOf(address) view returns (uint256)"],
            ethers.provider
        );

        // compute storage slot of WETH.balanceOf(WETH) and WETH.balanceOf(0x00..00)
        const BALANCE_MAP = 3;
        const slot0 = keccak256(defaultAbiCoder.encode(["address", "uint256"], [WETH.address, BALANCE_MAP]));
        const slot1 = keccak256(defaultAbiCoder.encode(["uint160", "uint256"], [0, BALANCE_MAP]));

        // fetch all the proof data
        let {accountProof, headerRLP, blockProof, accountRoot, slotProofs} = await getProofs(targetBlock, WETH.address, [slot0, slot1]);

        // prove the account storage root and store it
        await asProver.prove(
            encodeASProof(WETH.address, accountProof, headerRLP, blockProof),
            true
        );

        // prove each storage slot using the cached proof
        tx = await cssProver.prove(
            encodeCSSProof(WETH.address, targetBlock, accountRoot, slot0, slotProofs[slot0]),
            false 
        );
        await tx.wait();
        tx = await cssProver.prove(
            encodeCSSProof(WETH.address, targetBlock, accountRoot, slot1, slotProofs[slot1]),
            false
        );
        await tx.wait();

        // check that providing the wrong storage root fails as expected
        await expect(
            cssProver.prove(
                encodeCSSProof(WETH.address, targetBlock, ethers.BigNumber.from(accountRoot).add(1), slot1, slotProofs[slot1]),
                false
            )
        ).to.be.revertedWith("Cached storage root doesn't exist");
    })

    it("test multi storage slots", async function () {
        const { reliquary, mssProver, getProofs } = await loadFixture(fixtureAddProverValid);

        function encodeMSSProof(...args) {
            return defaultAbiCoder.encode(
                ["address", "bytes", "bytes", "bytes", "bytes", "bytes32[]", "bytes", "bool"],
                args
            );
        }

        function buildCompressedProof(
            account, accountProof, header, blockProof, slotProofs, includeHeader
        ) {
            let slots = Object.keys(slotProofs)
            let proofNodes = Array.from(new Set([].concat(...Object.values(slotProofs))))
            let proofs = slots.map((s) => {
                return slotProofs[s].map(node => proofNodes.indexOf(node))
            })
            proofNodes = "0x".concat(...proofNodes.map((n) => n.substring(2)));
            proofs = hexlify(RLP.encode(proofs));
            return encodeMSSProof(account, accountProof, header, blockProof, proofNodes, slots, proofs, includeHeader)
        }

        const WETH = new ethers.Contract(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            ["function balanceOf(address) view returns (uint256)"],
            ethers.provider
        );
        const account = WETH.address

        // compute storage slot of WETH.balanceOf(WETH) and WETH.balanceOf(0x00..00)
        const BALANCE_MAP = 3;
        const slots = [
            keccak256(defaultAbiCoder.encode(["address", "uint256"], [account, BALANCE_MAP])),
            keccak256(defaultAbiCoder.encode(["uint160", "uint256"], [0, BALANCE_MAP])),
        ]
        const includeHeader = true;

        // fetch all the proof data
        let {accountProof, headerRLP, blockProof, slotProofs} = await getProofs(
            targetBlock, account, slots, concatSlots=false
        );

        let tx = await mssProver.proveBatch(
            buildCompressedProof(account, accountProof, headerRLP, blockProof, slotProofs, includeHeader),
            false,
            { gasLimit: 1000000 }
        )
    })


    it("test logs", async function () {
        const { reliquary, blockHistory, lProver, getProofs } = await loadFixture(fixtureAddProverValid);

        function encodeProof(...args) {
            return defaultAbiCoder.encode(["uint256", "uint256", "bytes", "bytes", "bytes"], args)
        }

        let { headerRLP, blockProof } = await getProofs(targetBlock, ZERO_ADDR, []);
        const txIdx = 0;
        const logIdx = 1;
        const receiptProof = "0xf90131a02b93fee34700ed65203db4e5ba93ba2d696759beb8c226d908b29e8c23eff215a01774c1bfad432ae14b7e573dc393cd0422c95f5e2af8f258edb532c512810841a081ba5f594381eb2065c140e9571719bba8f6d5a0184b426651c19f1893e5f1efa0798d72111e01866e41725e9fa6a975f44c107c624a1cbf67ef804fd46d6dda1da01bec5d884f644dce22b4579d269e9e5345c49422a0e31337337a504c3e15a7f0a06eed59a46743d8e7014172b453fc87d44b18ce3ea4e53cd1ead181a2be927105a08e2a18e5082c7c5377d43ab8da9da0454343a27bd8ba2337022f300d747dd71aa06268d91234d96ccf288550ad162efae80b291fcbfd0e6d23dda33e9c7944a83aa05a3cfa98252ff1332cde50fa4394435e7cb00ffc01fd8211d37886547600e3208080808080808080f871a0ff354e276688deb53a63cacd72e632d8ce084bf375f3facc2f75455a88257ab9a00709f4563e3f0f9ebdb07982a2b24dade944d53d0bbac1d21799ed45876228d5a0fc795bb14c5d977ce7b21827cff8d991f6c72861c50e6d110499517210d596098080808080808080808080808080f9044220b9043e02f9043a0183019462b9010000280000000000000000000080000000000000400000000000000800000000000000000000000001000000000000000002000000080000000000000000000000010000000000000000000008000000200000000000000000000040008000000000000000000000000000000000000000000000000000000000000010000008000000000000000000000000000000000000000001000000080000004000000000000000000000001010000000000000000000000000000000000000000080000000000002000000000000000000000000000000000000001000040000000000000000200000000000000000000010000000000000000000500000410000000000f9032ff87a94c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2f842a0e1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109ca00000000000000000000000008032eaede5c55f744387ca53aaf0499abcd783e5a0000000000000000000000000000000000000000000000000209ce08c962b0000f89b94c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2f863a0ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3efa00000000000000000000000008032eaede5c55f744387ca53aaf0499abcd783e5a0000000000000000000000000877d9c970b8b5501e95967fe845b7293f63e72f7a0000000000000000000000000000000000000000000000000209ce08c962b0000f89b94f203ca1769ca8e9e8fe1da9d147db68b6c919817f863a0ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3efa0000000000000000000000000877d9c970b8b5501e95967fe845b7293f63e72f7a000000000000000000000000037a48e35d0e98c3bacfeb025bd76b173eb736257a00000000000000000000000000000000000000000000003cd23ce760b492b17ebf87994877d9c970b8b5501e95967fe845b7293f63e72f7e1a01c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1b84000000000000000000000000000000000000000000000000957779e78345638f80000000000000000000000000000000000000000000113c61f3b9621729cc2e1f8fc94877d9c970b8b5501e95967fe845b7293f63e72f7f863a0d78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822a00000000000000000000000008032eaede5c55f744387ca53aaf0499abcd783e5a000000000000000000000000037a48e35d0e98c3bacfeb025bd76b173eb736257b880000000000000000000000000000000000000000000000000209ce08c962b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003cd23ce760b492b17eb";

        let tx = await lProver.prove(encodeProof(txIdx, logIdx, receiptProof, headerRLP, blockProof), false);
        await tx.wait();

        const oobTxIdx = 331;
        const oobReceiptProof = "0xf90131a02b93fee34700ed65203db4e5ba93ba2d696759beb8c226d908b29e8c23eff215a01774c1bfad432ae14b7e573dc393cd0422c95f5e2af8f258edb532c512810841a081ba5f594381eb2065c140e9571719bba8f6d5a0184b426651c19f1893e5f1efa0798d72111e01866e41725e9fa6a975f44c107c624a1cbf67ef804fd46d6dda1da01bec5d884f644dce22b4579d269e9e5345c49422a0e31337337a504c3e15a7f0a06eed59a46743d8e7014172b453fc87d44b18ce3ea4e53cd1ead181a2be927105a08e2a18e5082c7c5377d43ab8da9da0454343a27bd8ba2337022f300d747dd71aa06268d91234d96ccf288550ad162efae80b291fcbfd0e6d23dda33e9c7944a83aa05a3cfa98252ff1332cde50fa4394435e7cb00ffc01fd8211d37886547600e3208080808080808080f871a0ff354e276688deb53a63cacd72e632d8ce084bf375f3facc2f75455a88257ab9a00709f4563e3f0f9ebdb07982a2b24dade944d53d0bbac1d21799ed45876228d5a0fc795bb14c5d977ce7b21827cff8d991f6c72861c50e6d110499517210d596098080808080808080808080808080e4820001a06091335ead2e28652f5cee2cdb2f1914eeea20793373888a7ed1e0e5a20f5426f8b1a0baf8bb28fc2f931acb17eea60ebe5e1bacab4c5af4c594caf1923ffbb114e041a02df5174e5cb15b9e3dbe247e7f7b6e8643d1ad443ff42b7f0acbce2db8cec744a02b9047c4182f17108913e9524234e7c6b9eff9a5436a5742f5963f15d9dee68ea03e564a6d01025930443ecba490499f606d09c3a653339c5302a1568a57e11dd8a0654e1900c5d42f2d255d3ac8d713fa4ae682a5e0956af21d5c7297bf3b0d1e63808080808080808080808080f90171a0c2d768d7d0c66c667df877b3a528b435a05f090d590a4e927f105392ccaf3024a039f38dd53fa90690a5c0462d30bc5fec93b2e298d0ebce924b40c00f1e962ec6a0a2da0bbc790a89430abbedb7849f48f8589183702d44cda2aaf71bb1f29ab5c2a08c85b3eb2b4d1a0a9325e64aaef0e3a6b4be432ca61bec37e0e71eddc744f73ca09f88ee30a0dcb6140c42a7a60c2a2cedd7bee192d31d1c9a942600fc6b05973da06769588ae30f44d050c558b6320e8a27490307884a0dfe24db5c17477404df6ba0b30b4572c1848f8aa5923fdecdd4d50d7f1943864fd36d36093c34449a05c9b5a033bbba9124f3a3a818002552eecae439865f2094a62c5f1e01ea5a5c9269fc57a08f54c4aecbeceff8d9687cbcfdb863cc80a0d3302cc6ccdb45b258fd53ea8dfaa0008926c7b101c528cc96d9fa65b36e101f3b853932bb0716e42ea9f30652a74ca0b1be00fa487840d1711d9c46dec6e3733de5472881e61d18ea42c0b13aa91f0d808080808080";

        await expect(
            lProver.prove(encodeProof(oobTxIdx, 0, oobReceiptProof, headerRLP, blockProof), false)
        ).to.be.revertedWith("receipt does not exist");

        await expect(
            lProver.prove(encodeProof(txIdx, 100, receiptProof, headerRLP, blockProof), false)
        ).to.be.revertedWith("log index does not exist");

        let {} = { headerRLP, blockProof } = await getProofs(preByzantiumBlock, ZERO_ADDR, []);

        const preByzantiumTxIdx = 0;
        const preByzantiumLogIdx = 0;
        const preByzantiumReceiptProof = "0xf871a0ffec6f4267e49f8607d3cd16d6c18be16f6819b8f71d996d6ea57960dd010677a034ba098772040e3ae782334587345a85430ae1d883b10ce47429061faf4b0e37808080808080a04bf990800f565772034e26b25bb7b9fef0e225dac6b2137da07e342d901310e88080808080808080f9028930b90285f90282a0f2020b231c5416c7d1cf91a173e8afc562f46f604a08a30832f23d61bcd8256882d1a9b9010000000040000000000000000000000000000000000000000000000400002000080000000000000000000000000000000000000000000000000000000000000000000000400000000000000008000000000000000000000000000000000000000000000020000000000000200000000000000000000004000000000010000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000200008000000000000000000000000002000080000000000000000000000000040008000000000000000000000000000000000000000000000002000000000000000000000000000000000000f90158f89b94f3db5fa2c66b7af3eb0c0b782510816cbe4813b8f863a0ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3efa000000000000000000000000053871c23523453988ebd6524fcb0ea29241ca4d2a00000000000000000000000008d12a197cb00d4747a1fe03395095ce2a5cc6819a000000000000000000000000000000000000000000000000000000000004c4b40f8b9948d12a197cb00d4747a1fe03395095ce2a5cc6819e1a0dcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7b880000000000000000000000000f3db5fa2c66b7af3eb0c0b782510816cbe4813b800000000000000000000000053871c23523453988ebd6524fcb0ea29241ca4d200000000000000000000000000000000000000000000000000000000004c4b4000000000000000000000000000000000000000000000000000000000004c4b40";
        tx = await lProver.prove(
            encodeProof(preByzantiumTxIdx, preByzantiumLogIdx, preByzantiumReceiptProof, headerRLP, blockProof),
            false
        );
        await tx.wait();
    })

    it("test birth certificate", async function () {
        const { reliquary, bcToken, bcProver, urier, getProofs } = await loadFixture(fixtureAddProverValid);

        const WETH = new ethers.Contract(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            ["function balanceOf(address) view returns (uint256)"],
            ethers.provider
        );

        function encodeProof(...args) {
            return defaultAbiCoder.encode(["address", "bytes", "bytes", "bytes"], args);
        }

        // prove targetBlock + 1
        let {accountProof, headerRLP, blockProof} = await getProofs(targetBlock + 1, WETH.address, []);
        tx = await bcProver.prove(encodeProof(WETH.address, accountProof, headerRLP, blockProof), true);
        await tx.wait();

        // check proving later block reverts
        let {} = {accountProof, headerRLP, blockProof} = await getProofs(targetBlock + 2, WETH.address, []);
        await expect(
            bcProver.prove(encodeProof(WETH.address, accountProof, headerRLP, blockProof), true)
        ).to.be.revertedWith("older block already proven");

        // check proving earlier block succeeds
        let {} = {accountProof, headerRLP, blockProof} = await getProofs(targetBlock, WETH.address, []);
        tx = await bcProver.prove(encodeProof(WETH.address, accountProof, headerRLP, blockProof), true);
        await tx.wait();

        // check proving the wrong account block fails
        let {} = {accountProof, headerRLP, blockProof} = await getProofs(targetBlock, WETH.address.replace("C", "D"), []);
        await expect(
            bcProver.prove(encodeProof(WETH.address, accountProof, headerRLP, blockProof), true)
        ).to.be.revertedWith("node hash incorrect");

        // check proving an empty account fails
        let {} = {accountProof, headerRLP, blockProof} = await getProofs(targetBlock, WETH.address.replace("C", "D"), []);
        await expect(
            bcProver.prove(
                encodeProof((WETH.address.replace("C", "D")).toLowerCase(), accountProof, headerRLP, blockProof),
                true
            )
        ).to.be.revertedWith("Account does not exist at block");

        await expect(bcToken.addURIProvider(urier.address, 0)).to.not.be.reverted;
        expect(
            await bcToken.tokenURI(ethers.utils.solidityPack(["uint64", "address"], [0, WETH.address]))
        ).contains("data:application/json;base64");

        expect(await bcToken.name()).equal("Birth Certificate Relic");
        expect(await bcToken.symbol()).equal("BCR");
    })

    it("test valid block hash fee", async function () {
        const { reliquary, bcProver } = await loadFixture(fixtureAddProverValid);

        const BlockHistory = await ethers.getContractFactory("BlockHistory");
        const blockHistory = BlockHistory.attach(await bcProver.blockHistory());

        const blockNum = await ethers.provider.getBlockNumber("latest");
        const block = await ethers.provider.getBlock(blockNum);
        await expect(
            reliquary.assertValidBlockHash(blockHistory.address, block.hash, blockNum, [])
        ).to.be.revertedWith("insufficient fee");

        await reliquary.setValidBlockFee({
            flags: 0x2,
            feeCredits: 0,
            feeWeiMantissa: 1,
            feeWeiExponent: 9,
            feeExternalId: 0
        }, ZERO_ADDR);
        await reliquary.assertValidBlockHash(blockHistory.address, block.hash, blockNum, [], { value: '1000000000' });

        await expect(
            reliquary.assertValidBlockHash(blockHistory.address, block.hash, blockNum, [], { value: '9999' })
        ).to.be.revertedWith("insufficient fee");
    })

    it("test ephemeral facts", async function () {
        const { ephemeralFacts, ssProver, lProver, receiver, getProofs } = await loadFixture(fixtureEphemeralFacts);
        function encodeSSProof(...args) {
            return defaultAbiCoder.encode(["address", "bytes", "bytes32", "bytes", "bytes", "bytes"], args);
        }

        const addr = ephemeralFacts.signer.address;
        const ETHER = ethers.BigNumber.from("1000000000000000000");
        const [_, requester] = await ethers.getSigners();

        const receiverAddr = receiver.address;
        const fakeProver = "0x" + "0".repeat(40);
        let context = {initiator: addr, receiver: receiverAddr, extra: "0x", gasLimit: 50000, requireSuccess: false};
        await expect(
            ephemeralFacts.proveEphemeral(context, fakeProver, "0x")
        ).to.be.revertedWith("unknown prover");

        const WETH = new ethers.Contract(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            ["function balanceOf(address) view returns (uint256)"],
            ethers.provider
        );
        let slot = "0x" + "0".repeat(64);

        // request the fact to be proven with a 0.5 ETH bounty
        await expect(ephemeralFacts.connect(requester).requestFact(
            WETH.address,
            defaultAbiCoder.encode(["string", "bytes32", "uint256"], ["StorageSlot", slot, targetBlock]),
            receiverAddr,
            "0x",
            context.gasLimit,
            {value: ETHER.div(2)}
        )).to.emit(ephemeralFacts, "FactRequested");

        let {accountProof, headerRLP, blockProof, slotProofs} = await getProofs(targetBlock, WETH.address, [slot]);
        let ssProof = encodeSSProof(WETH.address, accountProof, slot, slotProofs[slot], headerRLP, blockProof);
        
        let before = await ethers.provider.getBalance(addr);
        context.initiator = requester.address;
        let tx = ephemeralFacts.proveEphemeral(context, ssProver.address, ssProof);

        // should fail because context.extra is not correct
        await expect(tx).to.emit(ephemeralFacts, "ReceiveFailure");
        // but should still pay the bounty
        await expect(tx).to.emit(ephemeralFacts, "BountyPaid");

        let after = await ethers.provider.getBalance(addr);
        await expect(after.sub(before).div(ETHER.div(10)).toNumber()).to.be.greaterThanOrEqual(0);

        context.extra = defaultAbiCoder.encode(["string", "uint256", "uint256"], ["StorageSlot", slot, targetBlock]);
        context.initiator = addr;
        tx = ephemeralFacts.proveEphemeral(context, ssProver.address, ssProof);
        await expect(tx).to.emit(receiver, "FactReceived").withArgs(addr, "StorageSlot");
        await expect(tx).to.emit(ephemeralFacts, "ReceiveSuccess");

        // check that we fail when not providing enough gas
        context.gasLimit = 2000000;
        tx = ephemeralFacts.proveEphemeral(context, ssProver.address, ssProof, { gasLimit: 1000000 });
        await expect(tx).to.be.revertedWith("not enough gas for call");

        // check that we fail when requireSuccess is true
        context.requireSuccess = true;
        context.extra = "0x"; // incorrect data, should fail
        tx = ephemeralFacts.proveEphemeral(context, ssProver.address, ssProof);
        // revert message should be forwarded
        await expect(tx).to.be.revertedWith("extra data does not match fact signature");

        // check that we fail when providing a non-contract
        context.receiver = "0x0000000000000000000000000000000000000000"
        tx = ephemeralFacts.proveEphemeral(context, ssProver.address, ssProof);
        await expect(tx).to.be.revertedWith("call target not a contract")
    })

    it("test gov", async function () {
        const { reliquary, mockProver } = await loadFixture(fixture);

        const TimelockController = await ethers.getContractFactory("TimelockController");
        const timelock = await TimelockController.deploy(3600, [addr0], [addr0]);
        await reliquary.grantRole(await reliquary.DEFAULT_ADMIN_ROLE(), timelock.address);
        await reliquary.renounceRole(await reliquary.DEFAULT_ADMIN_ROLE(), addr0);

        await expect(
            reliquary.addProver(mockProver.address, 1)
        ).to.be.revertedWith("AccessControl: account 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 is missing role 0x1991205f9b9e6359222ed4bbde98eebd6c5a90f432c11ce781941f6acee3127e");
        await expect(
            reliquary.grantRole(await reliquary.ADD_PROVER_ROLE(), addr0)
        ).to.be.revertedWith("AccessControl: account 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 is missing role 0x0000000000000000000000000000000000000000000000000000000000000000");

        const grantAddProverRoleData = (await reliquary.populateTransaction.grantRole(await reliquary.ADD_PROVER_ROLE(), addr0)).data;
        await expect(
            timelock.schedule(reliquary.address, 0, grantAddProverRoleData, ethers.utils.hexZeroPad("0x", 32), ethers.utils.hexZeroPad("0x01", 32), 0)
        ).to.be.revertedWith("TimelockController: insufficient delay");
        await timelock.schedule(reliquary.address, 0, grantAddProverRoleData, ethers.utils.hexZeroPad("0x", 32), ethers.utils.hexZeroPad("0x01", 32), 3600);
        await expect(
            timelock.execute(reliquary.address, 0, grantAddProverRoleData, ethers.utils.hexZeroPad("0x", 32), ethers.utils.hexZeroPad("0x01", 32))
        ).to.be.revertedWith("TimelockController: operation is not ready");

        await helpers.time.increase(3600);
        await timelock.execute(reliquary.address, 0, grantAddProverRoleData, ethers.utils.hexZeroPad("0x", 32), ethers.utils.hexZeroPad("0x01", 32));

        let tx = await reliquary.addProver(mockProver.address, 1);
        let receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("PendingProverAdded");

        await helpers.time.increase(2 * 24 * 3600);
        tx = await reliquary.activateProver(mockProver.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("NewProver");
    })
})
