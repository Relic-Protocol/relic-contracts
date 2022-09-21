const { expect } = require("chai");
const { sign } = require("crypto");
const { defaultAbiCoder, keccak256 } = require("ethers/lib/utils");
const { artifacts, config, ethers, network, waffle } = require("hardhat");
const { loadFixture, solidity } = waffle;
const { readFileSync } = require("fs");
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
        const MERKLE_TREE_DEPTH = 13;
        const PROOF_DEPTH = 15;

        const { blockHistory } = await loadFixture(fixture);

        const forkBlock = config.networks.hardhat.forking.blockNumber;
        let endBlockNum = forkBlock - 1;
        let startBlockNum = endBlockNum + 1 - 2 ** PROOF_DEPTH;

        let firstDB = new sqlite3.Database('./test/data/proofs-first.db');
        let lastDB = new sqlite3.Database('./test/data/proofs-last.db');

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

        const AccToken = await ethers.getContractFactory("BirthCertificateRelic");
        const accToken = await AccToken.deploy(reliquary.address);
        await accToken.deployed();

        const BCProver = await ethers.getContractFactory("BirthCertificateProver");
        const bcProver = await BCProver.deploy(blockHistory.address, reliquary.address, accToken.address);
        await bcProver.deployed();

        tx = await accToken.setProver(bcProver.address, true);
        await tx.wait();

        return { reliquary, mockToken, mockProver, aToken, aProver, accToken, bcProver, urier };
    }

    async function fixtureAddProverValid(_wallets, _provider) {
        const { reliquary, mockToken, mockProver, aToken, aProver, accToken, bcProver, urier } = await loadFixture(fixture);

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

        return { reliquary, mockToken, mockProver, aToken, aProver, accToken, bcProver, urier };
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

    it("test bad issuing", async function () {
        const { reliquary, mockToken, mockProver } = await loadFixture(fixtureAddProverShortWait);
        await expect(mockProver.proveFactWithNFT(addr0, 1)).to.be.revertedWith("unknown prover");
    })

    it("test reliquary/subscription management", async function () {
        const { reliquary, mockToken, mockProver } = await loadFixture(fixtureAddProverValid);

        await expect(
            reliquary.addProver(mockProver.address, 1)
        ).to.be.revertedWith("duplicate version");
        await expect(
            reliquary.addProver(mockProver.address, 4)
        ).to.be.revertedWith("duplicate prover");


        const factCls = 1;
        const MockProver = await ethers.getContractFactory("MockProver");
        const mockProver2 = await MockProver.deploy(factCls, factsig0, reliquary.address, mockToken.address);
        await mockProver2.deployed();

        let tx = await reliquary.addProver(mockProver2.address, 4);
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
            mockProver2.proveFact(addr0, 1)
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
        await mockProver2.proveFact(addr0, 1);

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
        await mockProver2.proveFact(addr0, 2, { value: ethers.BigNumber.from("200000000000000000") });

        // test revokation
        tx = await reliquary.revokeProver(mockProver2.address);
        receipt = await tx.wait();
        expect(receipt.events.length).equals(1);
        expect(receipt.events[0].event).equals("ProverRevoked");

        await expect(mockProver2.proveFact(addr0, 2)).to.be.revertedWith("revoked prover");
    })

    it("test issuing", async function () {
        const { reliquary, mockToken, mockProver } = await loadFixture(fixtureAddProverValid);
        let expected = expect(await mockProver.proveFactWithNFT(addr0, 1));

        // should issue NFT "Transfer" and SBT "Locked"
        await expected.to.emit(mockToken, "Transfer");
        await expected.to.emit(mockToken, "Locked");

        const factsig = await mockProver.factSig();
        tx = await reliquary.verifyFact(addr0, factsig, { value: fee0 });
        receipt = await tx.wait();

        tx = await reliquary.verifyFactVersion(addr0, factsig, { value: fee0 });
        receipt = await tx.wait();

        tx = await mockProver.proveFactWithNFT(addr0, 1);
        receipt = await tx.wait();
        // should NOT issue NFT "Transfer", they've already got one
        expect(receipt.events.length).equals(0);

        // fake issue an invalid fact and ensure we throw properly
        expect(await cheatReadFact(reliquary, addr0, factsig)).not.equal(ethers.utils.hexZeroPad(0, 32))
        await cheatWriteFact(reliquary, addr0, factsig, "0x0000000000000000000000000000000000000000000000000000000000000002");

        await expect(reliquary.verifyFact(addr0, factsig, { value: fee0 })).to.be.revertedWith("fact data length invalid");
    })

    it("test attendance", async function () {
        const { reliquary, mockToken, mockProver, aToken, aProver, accToken, bcProver, urier } = await loadFixture(fixtureAddProverValid);

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

    it("test birth certificate", async function () {
        const { reliquary, mockToken, mockProver, aToken, aProver, accToken, bcProver, urier } = await loadFixture(fixtureAddProverValid);

        const BlockHistory = await ethers.getContractFactory("BlockHistoryForTesting");
        const blockHistory = BlockHistory.attach(await bcProver.blockHistory());

        // setup merkle root and proof for testing
        const MERKLE_TREE_DEPTH = 13;
        const BLOCKS_PER_CHUNK = 2 ** MERKLE_TREE_DEPTH;
        const targetBlock = config.networks.hardhat.forking.blockNumber - BLOCKS_PER_CHUNK;
        expect(targetBlock % BLOCKS_PER_CHUNK).to.equal(0);

        let block = await ethers.provider.getBlock(targetBlock);

        // real hashes for targetBlock ... targetBlock+2; fake hashes for rest
        let hashes = new Array(BLOCKS_PER_CHUNK).fill(block.hash);
        hashes[1] = (await ethers.provider.getBlock(targetBlock + 1)).hash;
        hashes[2] = (await ethers.provider.getBlock(targetBlock + 2)).hash;
        const root = buildMerkleRoot(hashes);
        let tx = await blockHistory.storeMerkleRootsForTesting(targetBlock / BLOCKS_PER_CHUNK, [root]);
        await tx.wait()

        async function getProofs(blockNum, account, slots) {
            expect(blockNum >= targetBlock && blockNum < targetBlock + BLOCKS_PER_CHUNK).to.equal(true);

            // use the base provider to fetch trie proofs, because hardhat doesn't support it
            const baseProvider = new ethers.providers.JsonRpcProvider(config.networks.hardhat.forking.url);
            const res = await baseProvider.send("eth_getProof", [account, slots, "0x" + blockNum.toString(16)]);

            // concatenate proof nodes
            const accountProof = "0x".concat(...res.accountProof.map((p) => p.substring(2)));

            const blockProof = encodeValidBlockMerkleProof(true, buildMerkleProof(hashes, blockNum - targetBlock));
            const rawHeader = await baseProvider.send("eth_getBlockByNumber", ["0x" + blockNum.toString(16), false]);
            const headerRLP = headerRlp(rawHeader);

            return [accountProof, headerRLP, blockProof];
        }

        const WETH = new ethers.Contract(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            ["function balanceOf(address) view returns (uint256)"],
            ethers.provider
        );

        /*
        // compute storage slot of WETH.balanceOf(WETH)
        const BALANCE_MAP = 3;
        const slot = keccak256(defaultAbiCoder.encode(["address", "uint256"], [WETH.address, BALANCE_MAP]));
        const expectedSlotVal = await WETH.balanceOf(WETH.address);
        expect(ethers.BigNumber.from(res.storageProof[0].value)).to.equal(expectedSlotVal);
        */

        // prove targetBlock + 1
        let [accountProof, header, blockProof] = await getProofs(targetBlock + 1, WETH.address, [/*slot*/]);
        tx = await bcProver.proveBirthCertificate(WETH.address, accountProof, header, blockProof);
        await tx.wait();

        // check proving later block reverts
        [accountProof, header, blockProof] = await getProofs(targetBlock + 2, WETH.address, [/*slot*/]);
        await expect(
            bcProver.proveBirthCertificate(WETH.address, accountProof, header, blockProof)
        ).to.be.revertedWith("older block already proven");

        // check proving earlier block succeeds
        [accountProof, header, blockProof] = await getProofs(targetBlock, WETH.address, [/*slot*/]);
        tx = await bcProver.proveBirthCertificate(WETH.address, accountProof, header, blockProof);
        await tx.wait();

        // check proving the wrong account block fails
        [accountProof, header, blockProof] = await getProofs(targetBlock, "0xD" + WETH.address.substring(3), [/*slot*/]);
        await expect(
            bcProver.proveBirthCertificate(WETH.address, accountProof, header, blockProof)
        ).to.be.revertedWith("node hash incorrect");


        // check proving an empty account fails
        [accountProof, header, blockProof] = await getProofs(targetBlock, "0xD" + WETH.address.substring(3), [/*slot*/]);
        await expect(
            bcProver.proveBirthCertificate(("0xD" + WETH.address.substring(3)).toLowerCase(), accountProof, header, blockProof)
        ).to.be.revertedWith("Account does not exist at block");

        await expect(accToken.addURIProvider(urier.address, 0)).to.not.be.reverted;
        expect(
            await accToken.tokenURI(ethers.utils.solidityPack(["uint64", "address"], [0, WETH.address]))
        ).contains("data:application/json;base64");

        expect(await accToken.name()).equal("Birth Certificate Relic");
        expect(await accToken.symbol()).equal("BCR");
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
