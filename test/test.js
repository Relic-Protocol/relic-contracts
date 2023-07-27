const { expect } = require("chai");
const { sign } = require("crypto");
const { hexlify, defaultAbiCoder, keccak256 } = require("ethers/lib/utils");
const { artifacts, config, ethers, network, waffle } = require("hardhat");
const { loadFixture, solidity } = waffle;
const { readFileSync } = require("fs");
const fetch = require('node-fetch');
const RLP = require("rlp");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const sqlite3 = require("sqlite3");

const {
    buildMerkleRoot, buildMerkleProof, validMerkleProof,
    encodeValidBlockMerkleProof, encodeValidBlockSNARKProof,
    signProof, headerRlp, readHashWords
} = require("../utils/blockproof");

const ZERO_ADDR = "0x" + "0".repeat(40);
const ZERO_HASH = "0x" + "0".repeat(64);
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
const PROOF_DEPTH = 14;


const forkBlock = config.networks.hardhat.forking.blockNumber;
const endBlockNum = forkBlock - 1;
const startBlockNum = endBlockNum + 1 - 2 ** PROOF_DEPTH;

const db = new sqlite3.Database('./test/data/proofs.db');

const BLOCK_DIR = process.env.BLOCK_DIR;
const PROOF_URL = process.env.PROOF_URL;
function addBlocks(base, num) {
    for (var i = base; i < base + num; i++) {
        let hash = keccak256(readFileSync(`${BLOCK_DIR}/${i}`));
        let sql = "insert into blocks (num, hash) values (?,?)"
        db.run(sql, [i, hash]);
    }
}
//addBlocks(startBlockNum, 2**PROOF_DEPTH);
//addBlocks(0, 2**PROOF_DEPTH);

async function addProof(start, size) {
    console.log(start, size);
    let circuit_type = `outer_${size / 16}`;
    let idx = start / size;
    let url = `${PROOF_URL}/proof?block=${start}&count=${size}`;
    let resp = await fetch(url).then(r => r.json());
    return new Promise((res, rej) => {
        const sql = "insert into proofs (circuit_type, idx, work_id, proof, calldata) values (?,?,?,?,?)";
        db.run(sql, [circuit_type, idx, "", "", resp.calldata], function(err) {
            if (err) rej(err);
            res();
        });
    });
}

async function addProofs(base, num) {
    let proms = [];
    for (var size = 2**MERKLE_TREE_DEPTH; size <= num; size *= 2) {
        for (var start = base; start < base + num; start += size) {
            proms.push(addProof(start, size));
        }
    }
    await Promise.all(proms)
}
//addProofs(0, 2**PROOF_DEPTH);
//addProofs(startBlockNum, 2**PROOF_DEPTH);

function getBlockHash(num) {
    expect(
        (num >= startBlockNum && num <= endBlockNum) ||
        (num >= 0 && num <= 2 ** PROOF_DEPTH)
    ).to.equal(true);
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
    let idx = startBlock / numBlocks;
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

async function getAuxRoot(startBlock, endBlock) {
    let proof = await loadProof(startBlock, endBlock);
    return proof.inputs[12];
}

describe("AuxRoots", function () {
    it("test blockHistory", async function () {
        const AuxRootTest = await ethers.getContractFactory("AuxRootTest");
        const auxRootTest = await AuxRootTest.deploy();
        await auxRootTest.deployed();


        const l1 = await auxRootTest.auxRoot([ZERO_HASH, ZERO_HASH]);
        const l2 = await auxRootTest.auxRoot([l1, l1]);
        const other = await auxRootTest.auxRoot([ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH]);
        await expect(l2).to.equal(other);
    })
})

// must run first because we rely on the hardhat fork block being recent
describe("Blocks", function () {
    async function fixture(_wallets, _provider) {
        const sizes = config.relic.vkSizes;
        let verifiers = [];
        for (var i = 0; i < sizes.length; i++) {
            let vkRaw = readFileSync(`test/data/rendered-vk-outer-${sizes[i] / 16}`);
            const [vk] = defaultAbiCoder.decode(["uint256[35]"], vkRaw);
            const Verifier = await ethers.getContractFactory("contracts/Verifier.yul:Verifier");
            const verifier = await Verifier.deploy(vk);
            await verifier.deployed();
            verifiers.push(verifier.address);
        }

        const BlockHistory = await ethers.getContractFactory("BlockHistoryForTesting");
        const blockHistory = await BlockHistory.deploy(sizes, verifiers, ZERO_ADDR);
        await blockHistory.deployed();;

        const tx = await blockHistory.setSigner(ZERO_ADDR);
        await tx.wait();

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
        let lastAuxRoots = await Promise.all(range(numRoots).map(async (i) => {
            let start = startBlockNum + i * 2 ** MERKLE_TREE_DEPTH;
            let end = start + 2 ** MERKLE_TREE_DEPTH - 1;
            return getAuxRoot(start, end);
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
            blockHistory.importLast(endBlockNum, [lastProof, "0x"], lastRoots, lastAuxRoots, "0x")
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
        await blockHistory.setEarliestRootForTesting(2 ** (PROOF_DEPTH - MERKLE_TREE_DEPTH));

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
        let firstAuxRoots = await Promise.all(range(numRoots).map(async (i) => {
            let start = i * 2 ** MERKLE_TREE_DEPTH;
            let end = start + 2 ** MERKLE_TREE_DEPTH - 1;
            return getAuxRoot(start, end);
        }));
        let firstProof = await loadProof(0, 2 ** PROOF_DEPTH - 1);

        await expect(
            blockHistory.importParent([firstProof, "0x"], firstRoots, firstAuxRoots)
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
            blockHistory.importLast(endBlockNum, [lastProof, "0x"], lastRoots, lastAuxRoots, "0x")
        ).to.emit(blockHistory, "ImportMerkleRoot");

        let signer = await ethers.getSigner(addr0);
        await expect(blockHistory.setSigner(addr0)).to.emit(blockHistory, "NewSigner");

        // reset the hashes to do importLast again
        await blockHistory.setHashesForTesting(await blockHistory.parentHash(), fakeLastHash);

        console.log("testing importLast with signature...");
        await expect(
            // no signature should now fail
            blockHistory.importLast(endBlockNum, [lastProof, "0x"], lastRoots, lastAuxRoots, "0x")
        ).to.be.revertedWith("ECDSA: invalid signature length");

        await expect(
            // sign the wrong proof, should fail
            blockHistory.importLast(endBlockNum, [lastProof, await signProof(signer, firstProof)], lastRoots, lastAuxRoots, "0x")
        ).to.be.revertedWith("invalid SNARK");

        let lastAuxRoots0 = lastAuxRoots.slice(0, lastAuxRoots.length / 2);
        let incorrectAux = [].concat(lastAuxRoots0, lastAuxRoots0);
        await expect(
            // incorrect lastAuxRoots should fail
            blockHistory.importLast(endBlockNum, [lastProof, await signProof(signer, firstProof)], lastRoots, incorrectAux, "0x")
        ).to.be.revertedWith("invalid aux roots");

        await expect(
            // correct signature, should work
            blockHistory.importLast(endBlockNum, [lastProof, await signProof(signer, lastProof)], lastRoots, lastAuxRoots, "0x")
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
        await blockHistory.importLast(middle - 1, [lastProof0, "0x"], lastRoots0, lastAuxRoots0, connectProof);
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

        // setup merkle roots used in tests, NOTE: auxiliary roots are wrong
        tx = await blockHistory.storeMerkleRootsForTesting(targetBlock / BLOCKS_PER_CHUNK, [root], [root]);
        await tx.wait()

        tx = await blockHistory.storeMerkleRootsForTesting(Math.floor(preByzantiumBlock / BLOCKS_PER_CHUNK), [preByzantiumRoot], [preByzantiumRoot]);
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

        const TProver = await ethers.getContractFactory("TransactionProver");
        const tProver = await TProver.deploy(blockHistory.address, reliquary.address);
        await tProver.deployed();

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

        const AIProver = await ethers.getContractFactory("AccountInfoProver");
        const aiProver = await AIProver.deploy(blockHistory.address, reliquary.address);
        await aiProver.deployed();

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

            return { accountProof, headerRLP, blockProof, accountRoot, slotProofs };
        }
        return { reliquary, blockHistory, mockToken, mockProver, aToken, aProver, bcToken, bcProver, ssProver, lProver, tProver, bhProver, cssProver, asProver, aiProver, mssProver, urier, getBlockHeader, getProofs };
    }

    async function fixtureAddProverValid(_wallets, _provider) {
        const { reliquary, blockHistory, mockToken, mockProver, aToken, aProver, bcToken, bcProver, ssProver, lProver, tProver, bhProver, cssProver, asProver, aiProver, mssProver, urier, getBlockHeader, getProofs } = await loadFixture(fixture);

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
        let provers = [bcProver, ssProver, lProver, tProver, bhProver, cssProver, asProver, mssProver, aiProver];
        for (let i = 0; i < provers.length; i++) {
            tx = await reliquary.addProver(provers[i].address, i + 3);
            receipt = await tx.wait();
            expect(receipt.events.length).equals(1);
            expect(receipt.events[0].event).equals("PendingProverAdded");
        }

        await expect(
            reliquary.activateProver(bcProver.address)
        ).to.be.revertedWith("not ready");

        await helpers.time.increase(2 * 24 * 3600);
        await expect(
            reliquary.activateProver(mockProver.address)
        ).to.be.revertedWith("duplicate prover");

        for (let i = 0; i < provers.length; i++) {
            tx = await reliquary.activateProver(provers[i].address);
            receipt = await tx.wait();
            expect(receipt.events.length).equals(1);
            expect(receipt.events[0].event).equals("NewProver");
        }

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

        for (let i = 0; i < provers.length; i++) {
            await reliquary.setProverFee(provers[i].address, {
                flags: 0x1, // none
                feeCredits: 0,
                feeWeiMantissa: 0,
                feeWeiExponent: 0,
                feeExternalId: 0
            }, ZERO_ADDR)
        }

        return { reliquary, blockHistory, mockToken, mockProver, aToken, aProver, bcToken, bcProver, ssProver, lProver, tProver, bhProver, cssProver, asProver, aiProver, mssProver, urier, getBlockHeader, getProofs };
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
        let { accountProof, headerRLP, blockProof, slotProofs } = await getProofs(targetBlock, WETH.address, [slot]);
        tx = await ssProver.prove(
            encodeProof(WETH.address, accountProof, slot, slotProofs[slot], headerRLP, blockProof),
            true
        );
        await tx.wait();

        // check proving the wrong account block fails
        const fakeAddr = WETH.address.replace("C", "D").toLowerCase();
        let { } = { accountProof, headerRLP, blockProof, slotProofs } = await getProofs(targetBlock, fakeAddr, [slot]);
        await expect(
            ssProver.prove(encodeProof(WETH.address, accountProof, slot, slotProofs[slot], headerRLP, blockProof), true),
        ).to.be.revertedWith("node hash incorrect");

        // check proving a missing slot succeeds (value should be 0)
        const emptySlot = keccak256(defaultAbiCoder.encode(["address", "uint256"], [fakeAddr, BALANCE_MAP]));
        expect(await WETH.balanceOf(fakeAddr)).to.equal(0);

        let { } = { accountProof, headerRLP, blockProof, slotProofs } = await getProofs(targetBlock, WETH.address, [emptySlot]);
        tx = await ssProver.prove(
            encodeProof(WETH.address, accountProof, emptySlot, slotProofs[emptySlot], headerRLP, blockProof),
            true
        );
        await tx.wait();

        // proving a slot from an empty storage trie should succeed
        const nonContract = "0x0000000000000000000000000000000000000000";
        let { } = { accountProof, headerRLP, blockProof, slotProofs } = await getProofs(targetBlock, nonContract, [slot]);
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

        let hashes = await Promise.all(range(2 ** MERKLE_TREE_DEPTH).map((i) => getBlockHash(i)));
        let root = buildMerkleRoot(hashes);
        let tx = await blockHistory.storeMerkleRootsForTesting(0, [root], [root]);
        await tx.wait()

        let proof = encodeValidBlockMerkleProof(true, buildMerkleProof(hashes, blockNum));
        let headerRLP = await getBlockHeader(blockNum);

        tx = await bhProver.prove(encodeProof(headerRLP, proof), false);
        await tx.wait();
    })

    it("test account info proofs", async function () {
        const { aiProver, getProofs } = await loadFixture(fixtureAddProverValid);

        function encodeAIProof(...args) {
            return defaultAbiCoder.encode(["address", "bytes", "bytes", "bytes", "uint8"], args);
        }
        const WETHAddr = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

        // fetch all the proof data
        let { accountProof, headerRLP, blockProof } = await getProofs(targetBlock, WETHAddr, []);

        // proofs of  StorageRoot, CodeHash, RawHeader, Balance, Nonce, respectively
        await aiProver.prove(encodeAIProof(WETHAddr, accountProof, headerRLP, blockProof, 0), true);
        await aiProver.prove(encodeAIProof(WETHAddr, accountProof, headerRLP, blockProof, 1), true);


        var tx = await aiProver.prove(encodeAIProof(WETHAddr, accountProof, headerRLP, blockProof, 2), true);
        let balance = await ethers.provider.getBalance(WETHAddr, targetBlock);
        expect((await tx.wait()).events[0].args[0][2]).to.equal(balance);

        tx = await aiProver.prove(encodeAIProof(WETHAddr, accountProof, headerRLP, blockProof, 3), true);
        expect((await tx.wait()).events[0].args[0][2]).to.equal(ethers.BigNumber.from(1));

        tx = await aiProver.prove(encodeAIProof(WETHAddr, accountProof, headerRLP, blockProof, 4), true);
        let header = defaultAbiCoder.decode(["uint256", "uint256", "bytes32", "bytes32"], (await tx.wait()).events[0].args[0][2]);
        expect(header[0]).to.equal(ethers.BigNumber.from(1));
        expect(header[1]).to.equal(balance);
        expect(header[2]).to.equal('0x76643f129d938c49d13bf455319a1086255d059e0f570889ddb1a634d6ab8d59');
        expect(header[3]).to.equal('0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23');
        // invalid type
        await expect(aiProver.prove(encodeAIProof(WETHAddr, accountProof, headerRLP, blockProof, 5), true)).to.be.reverted;
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
        let { accountProof, headerRLP, blockProof, accountRoot, slotProofs } = await getProofs(targetBlock, WETH.address, [slot0, slot1]);

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
        let { accountProof, headerRLP, blockProof, slotProofs } = await getProofs(
            targetBlock, account, slots, concatSlots = false
        );

        let tx = await mssProver.proveBatch(
            buildCompressedProof(account, accountProof, headerRLP, blockProof, slotProofs, includeHeader),
            false,
            { gasLimit: 1000000 }
        )
    })

    it("test transaction", async function () {
        const { reliquary, blockHistory, tProver, getProofs } = await loadFixture(fixtureAddProverValid);

        function encodeProof(...args) {
            return defaultAbiCoder.encode(["uint256", "bytes", "bytes", "bytes"], args)
        }

        console.log(targetBlock);
        let { headerRLP, blockProof } = await getProofs(targetBlock, ZERO_ADDR, []);
        const txIdx = 0;
        const txProof = "0xf90131a0f348c9a153f67f01b7a3dab0dcb7611ad7b37f354d28e7e2a81270f9d173b0c7a05cd917f9ad7e57c33f2a2e53a9d0b61e6c1c771c1e642f31a9c19e668af9f350a036805f3adadd198374151657ad5525a16116ba611fb2e60e8fee83f7a03c22d7a0c71eb9d7c6af2b5c6a06a8702d6e75831ce88e93f59d0783a0bb1b4c780ad62ba0fc1a8e52f8b69e92f013530d06f5cc1efb36eb0a1ccce1a133b2df44cc016175a0adcede28a7be8acc30372243d2cce379c9d28ce94cc68a76c479bedfd08995caa0227547fc2154d7ba40863f276714de78505aa9b24b624cc8be10064c3c85997ea0a5f50dc89f83f082b33006de0d58de0361fc07bd4763171184fc07ea96ebb891a08dae7938181d439c7d94b42ade28ed6bff3c0f7452aaa745283f5a87faaa79f88080808080808080f851a0abb30c992ab3df329c8e30cc976a0570ff573b2ea5fbd1cc9c29202a53ae9524a0b2b7135a93ff7892f0e1aef5641772ab3a54c33769b94efe77b2b940d9ed477e808080808080808080808080808080f9017d20b9017902f901750182215f850ba43b740085174a3a980a83028565947a250d5630b4cf539739df2c5dacb4c659f2488d80b90104791ac94700000000000000000000000000000000000000003c1bd650024a280a9d0a2d0f00000000000000000000000000000000000000000000000001513af140c9fe0000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000009dda370f43567b9c757a3f946705567bce482c42000000000000000000000000000000000000000000000000000000006439b05d00000000000000000000000000000000000000000000000000000000000000020000000000000000000000002efd3c85fb08a1bb901b1351f8bb596da7b4b711000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2c001a0e5022ab879d0c356f1362d54a8a1d6b7d13f4f61619102a91d7be649071f4caca04d82d738d6015d44b2131b341ceee37e17b9cef7abc5aab7f24676b5e28b4008";

        const txHash = '0x1fcfd598d7435abd479bf380041c30f0db3f1dddf18404aeab4262c171798a0b';

        let tx = await tProver.prove(encodeProof(txIdx, txProof, headerRLP, blockProof), false);
        const expected = ("0x" + keccak256(defaultAbiCoder.encode(["string", "bytes32"], ["Transaction", txHash])).substring(4) + "00");
        expect((await tx.wait()).events[0].args.fact.sig).to.equal(expected);

        let { } = { headerRLP, blockProof } = await getProofs(preByzantiumBlock, ZERO_ADDR, []);

        const preByzantiumTxIdx = 13;
        const preByzantiumTxProof = "0xf871a0a39afa6bee91397fdac7e5d6e4ce5294780faa5a281a6692b84c9cf4a3a09d5ba035164cd9d2900cf073a8b1b1dca6ed1ff7e437fa5029ffcf9aa970442af64994808080808080a09d9900269a5be8f4adc6cd1b77ec50f2cdb5bec283768f4af22c987aed865b638080808080808080f901f180a0909afeebf164b38c0c8eaf7466633db70286a30ce17b8f3e4430629c203b1ac2a0ec8912dd0ff111652b30f70663be2eee6f021ab871d6e25fd83390c5ad0e667ba062b0201bb21b091b0b9fc9eff1417ce0ea27b1d5926fc4b1e1088b9422948b67a0b280077d7516aa2831166a6b9bb521a83a1924553370367b7d05c318fd641de5a0f03b2eb4242c4827ff944f0e7db4670b8d6ee7121c8ad59c42a570fd41cb169ca0f16ecd6d4834fbe407daf89b5d17ebfcfcba796bf2fef20448914769752b5eeaa0b4f376b6867f53733959903c992db779268d937b815f1082e6b0090323f23747a06e96a1384fe87d470160dd606cd4ba0f0e595d30fd7700be23c060788440f20fa0b1ea086ac80354f452f83a21e6d0f2f021de19a46d09ecb4ae70e5d2df0bee02a04a37def3383ed510fc6a654b8c8ccf155da6e49b641dc6078214708a6ea62336a0ebbcc305c26b6263dbabcf6e5847a297890f78daacecec773d2fed7e07adfe82a07fb5c04b95964f3804e669c86e0d64aa405285492c20dc49e380a2b8fd88b89ba0ee1035418cf03157b29dfa483e8846a435b601bd089b3157eded2c5e94fe70e5a017be2bc21327ffa5ef06bb6cee132fd973ad99e4017225f49d883b47acc9085ca032864287cd1aff9fae83a06f12ccc5e50e8374d56bc23fbc212fbe3744e1f87280f901d320b901cff901cc82040a8502540be4008303d090948d12a197cb00d4747a1fe03395095ce2a5cc681980b901640a19b14a0000000000000000000000004156d3342d5c385a87d264f9065373359200058100000000000000000000000000000000000000000000000000000002540be40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c12dc63fa970000000000000000000000000000000000000000000000000000000000000042d552000000000000000000000000000000000000000000000000000000005c6fe83a0000000000000000000000008aff5f6782032de53f5c9cbf4abe0e6358ae419e000000000000000000000000000000000000000000000000000000000000001ce18156e901adbaeb0fb38d30e0c74e3b94bb13b0e02f16cc009e49576050d2d87fd00d73811a7540504e34a2007e12a37ab9752d8242da066906ae5765d33ebc00000000000000000000000000000000000000000000000000000002540be4001ba08e88fc3d1191c3a80715fbf91a2780ce1b4e83adc9a65cf0dcc49ffb4597c0699f387dc7158279c213d89f02696f9e7915f38c76ba3221dd87586a3f77236c21";
        tx = await tProver.prove(
            encodeProof(preByzantiumTxIdx, preByzantiumTxProof, headerRLP, blockProof),
            false
        );
        await tx.wait();
    })

    it("test logs", async function () {
        const { reliquary, blockHistory, lProver, getProofs } = await loadFixture(fixtureAddProverValid);

        function encodeProof(...args) {
            return defaultAbiCoder.encode(["uint256", "uint256", "bytes", "bytes", "bytes"], args)
        }

        let { headerRLP, blockProof } = await getProofs(targetBlock, ZERO_ADDR, []);
        const txIdx = 0;
        const logIdx = 1;
        const receiptProof = "0xf90131a009d7bd13fc1da64f9f83b2ddac3446499601f5574842fd5351a1ddc7bb85a711a00b58ce5acc58241ab5e1d480e79cf1bb020883203a42e48a108dc9b7df1629e4a0f18eee06410397ace8b23d9e344fb69ddb7bf4f1b881e91acbf28fd70e8b07c9a0582a877f65a431a9495fc0118fb23516fed3e4cdfdb4d76ce2d29074c81dd363a0e3e1c30de3049fba04442f995883ff1208870ced7587593a018ea7bfdedae51da043942c9c0677453fccc0f4292aaa06d1c383523858c1a60ac43476865cad4a3ba07af1fb1b6e1c9ea449b57689a7cc89d1a7bf2b1d4fb73440800282aaa6b55f3aa0f4d09618662fd680fdcf4331262bd685bdb6e1564ea97d5596e4d337c3acfee8a0e875593b9bb39fa9ccc17dfa599eae72b08c5a677012378e15de4e0c023a65ab8080808080808080f851a0a084afcc241b2e52e9628fbfb2538c2e7a20933e56b753eb92b9897d4c12d36ca0c5991d966fe94b48b8429d30ce75023c70bd5986e11165555030f0c054513cb2808080808080808080808080808080f904df20b904db02f904d7018301cbc9b90100002000000000000010000000800010000000000000000100000100000000000000000000000000000000000000000000020000000a0000000000000000201000000800000000000002000008000000200000000000400000000000000000000000000000000000000000000000000002000000000001040000000010000000000000000000000000004004000000000000000000000000080000004000010000020000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000001000000002000020000010200000000000000000000000000000000000000000000000000000000000f903ccf89b942efd3c85fb08a1bb901b1351f8bb596da7b4b711f863a0ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3efa00000000000000000000000009dda370f43567b9c757a3f946705567bce482c42a00000000000000000000000000ad98ae69de9355fac4d6ec3036da58b92c0f6f6a000000000000000000000000000000000000000003c1bd650024a280a9d0a2d0ff89b942efd3c85fb08a1bb901b1351f8bb596da7b4b711f863a08c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925a00000000000000000000000009dda370f43567b9c757a3f946705567bce482c42a00000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488da0fffffffffffffffffffffffffffffffffffffffdd6aeb8171cf94181716045cbf89b94c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2f863a0ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3efa00000000000000000000000000ad98ae69de9355fac4d6ec3036da58b92c0f6f6a00000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488da000000000000000000000000000000000000000000000000002320ce76bfb5200f879940ad98ae69de9355fac4d6ec3036da58b92c0f6f6e1a01c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1b8400000000000000000000000000000000000000006eba8728da049c637153b968d0000000000000000000000000000000000000000000000003eb419f472df312df8fc940ad98ae69de9355fac4d6ec3036da58b92c0f6f6f863a0d78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822a00000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488da00000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488db88000000000000000000000000000000000000000003c1bd650024a280a9d0a2d0f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002320ce76bfb5200f87a94c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2f842a07fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65a00000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488da000000000000000000000000000000000000000000000000002320ce76bfb5200";

        let tx = await lProver.prove(encodeProof(txIdx, logIdx, receiptProof, headerRLP, blockProof), false);
        await tx.wait();

        const oobTxIdx = 331;
        const oobReceiptProof = "0xf90131a009d7bd13fc1da64f9f83b2ddac3446499601f5574842fd5351a1ddc7bb85a711a00b58ce5acc58241ab5e1d480e79cf1bb020883203a42e48a108dc9b7df1629e4a0f18eee06410397ace8b23d9e344fb69ddb7bf4f1b881e91acbf28fd70e8b07c9a0582a877f65a431a9495fc0118fb23516fed3e4cdfdb4d76ce2d29074c81dd363a0e3e1c30de3049fba04442f995883ff1208870ced7587593a018ea7bfdedae51da043942c9c0677453fccc0f4292aaa06d1c383523858c1a60ac43476865cad4a3ba07af1fb1b6e1c9ea449b57689a7cc89d1a7bf2b1d4fb73440800282aaa6b55f3aa0f4d09618662fd680fdcf4331262bd685bdb6e1564ea97d5596e4d337c3acfee8a0e875593b9bb39fa9ccc17dfa599eae72b08c5a677012378e15de4e0c023a65ab8080808080808080f851a0a084afcc241b2e52e9628fbfb2538c2e7a20933e56b753eb92b9897d4c12d36ca0c5991d966fe94b48b8429d30ce75023c70bd5986e11165555030f0c054513cb2808080808080808080808080808080";

        await expect(
            lProver.prove(encodeProof(oobTxIdx, 0, oobReceiptProof, headerRLP, blockProof), false)
        ).to.be.revertedWith("receipt does not exist");

        await expect(
            lProver.prove(encodeProof(txIdx, 100, receiptProof, headerRLP, blockProof), false)
        ).to.be.revertedWith("log index does not exist");

        let { } = { headerRLP, blockProof } = await getProofs(preByzantiumBlock, ZERO_ADDR, []);

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
        let { accountProof, headerRLP, blockProof } = await getProofs(targetBlock + 1, WETH.address, []);
        tx = await bcProver.prove(encodeProof(WETH.address, accountProof, headerRLP, blockProof), true);
        await tx.wait();

        // check proving later block reverts
        let { } = { accountProof, headerRLP, blockProof } = await getProofs(targetBlock + 2, WETH.address, []);
        await expect(
            bcProver.prove(encodeProof(WETH.address, accountProof, headerRLP, blockProof), true)
        ).to.be.revertedWith("older block already proven");

        // check proving earlier block succeeds
        let { } = { accountProof, headerRLP, blockProof } = await getProofs(targetBlock, WETH.address, []);
        tx = await bcProver.prove(encodeProof(WETH.address, accountProof, headerRLP, blockProof), true);
        await tx.wait();

        // check proving the wrong account block fails
        let { } = { accountProof, headerRLP, blockProof } = await getProofs(targetBlock, WETH.address.replace("C", "D"), []);
        await expect(
            bcProver.prove(encodeProof(WETH.address, accountProof, headerRLP, blockProof), true)
        ).to.be.revertedWith("node hash incorrect");

        // check proving an empty account fails
        let { } = { accountProof, headerRLP, blockProof } = await getProofs(targetBlock, WETH.address.replace("C", "D"), []);
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
        let context = { initiator: addr, receiver: receiverAddr, extra: "0x", gasLimit: 50000, requireSuccess: false };
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
            { value: ETHER.div(2) }
        )).to.emit(ephemeralFacts, "FactRequested");

        let { accountProof, headerRLP, blockProof, slotProofs } = await getProofs(targetBlock, WETH.address, [slot]);
        let ssProof = encodeSSProof(WETH.address, accountProof, slot, slotProofs[slot], headerRLP, blockProof);

        let before = await ethers.provider.getBalance(addr);
        context.initiator = requester.address;
        let tx = ephemeralFacts.proveEphemeral(context, ssProver.address, ssProof);

        // should fail because context.extra is not correct
        await expect(tx).to.emit(ephemeralFacts, "ReceiveFailure");
        // but should still claim the bounty
        await expect(tx).to.emit(ephemeralFacts, "BountyClaimed");

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
        const timelock = await TimelockController.deploy(3600, [addr0], [addr0], addr0);
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
