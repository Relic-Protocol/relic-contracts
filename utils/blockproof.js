const {
    arrayify, concat, defaultAbiCoder, sha256, keccak256,
    solidityPack, ParamType, RLP
} = require("ethers/lib/utils");

const MERKLE_PROOF_TYPE = 0;
const SNARK_PROOF_TYPE = 1;

function buildMerkleRoot(hashes) {
    let count = hashes.length;
    let temp = new Array(count / 2);
    for (let i = 0; i < count; i += 2) {
        temp[i >> 1] = sha256(concat([hashes[i], hashes[i + 1]]));
    }
    count >>= 1;
    while (count > 1) {
        for (let i = 0; i < count; i += 2) {
            temp[i >> 1] = sha256(concat([temp[i], temp[i + 1]]));
        }
        count >>= 1;
    }
    return temp[0];
}

function buildMerkleProof(hashes, idx) {
    let count = hashes.length;
    let temp = new Array(count / 2);
    let proof = new Array();
    for (let i = 0; i < count; i += 2) {
        if (idx == i) {
            proof.push(hashes[i + 1]);
        } else if (idx == i + 1) {
            proof.push(hashes[i]);
        }
        temp[i >> 1] = sha256(concat([hashes[i], hashes[i + 1]]));
    }
    idx >>= 1;
    count >>= 1;
    while (count > 1) {
        for (let i = 0; i < count; i += 2) {
            if (idx == i) {
                proof.push(temp[i + 1]);
            } else if (idx == i + 1) {
                proof.push(temp[i]);
            }
            temp[i >> 1] = sha256(concat([temp[i], temp[i + 1]]));
        }
        count >>= 1;
        idx >>= 1;
    }
    return proof;
}

function validMerkleProof(root, idx, hash, proofHashes) {
    let constructedHash = hash;
    for (let i = 0; i < proofHashes.length; i++) {
        if (idx & 1) {
            constructedHash = sha256(concat([proofHashes[i], constructedHash]));
        } else {
            constructedHash = sha256(concat([constructedHash, proofHashes[i]]));
        }
        idx >>= 1;
    }
    return root == constructedHash;
}

function headerRlp(header) {
    let list = [
        header.parentHash,
        header.sha3Uncles,
        header.miner,
        header.stateRoot,
        header.transactionsRoot,
        header.receiptsRoot,
        header.logsBloom,
        header.difficulty,
        header.number,
        header.gasLimit,
        header.gasUsed,
        header.timestamp,
        header.extraData,
        header.mixHash,
        header.nonce,
    ];
    if (header.baseFeePerGas) {
        list.push(header.baseFeePerGas);
    }

    list = list.map((v) => {
        if (v.length % 2 == 0) {
            return v;
        } else {
            return "0x0" + v.substring(2);
        }
    });
    return RLP.encode(list)
}


function encodeValidBlockMerkleProof(wrap, merkle) {
    let writer = defaultAbiCoder._getWriter();
    let type = ParamType.from("bytes32[]");
    defaultAbiCoder._getCoder(type).encode(writer, merkle);
    let proof = writer.data;
    if (wrap) return solidityPack(["uint8", "bytes"], [MERKLE_PROOF_TYPE, proof]);
    return proof;
}

async function encodeValidBlockSNARKProof(signer, wrap, numBlocks, endBlock, snark, merkle) {
    let sig = signer == null ? "0x" : await signProof(signer, snark);
    let proof = defaultAbiCoder.encode(
        [
            "uint256", "uint256",
            "tuple(tuple(uint256[34] base, uint256[16] subproofLimbs, uint256[] inputs), bytes)",
            "bytes32[]"
        ],
        [numBlocks, endBlock, [snark, sig], merkle]
    );
    if (wrap) return solidityPack(["uint8", "bytes"], [SNARK_PROOF_TYPE, proof]);
    return proof;
}

async function signProof(signer, proof) {
    let data = solidityPack(
        ["uint256[34]", "uint256[16]", "uint256[]"],
        [proof.base, proof.subproofLimbs, proof.inputs]
    );
    let hash = keccak256(data);
    return signer.signMessage(arrayify(hash));
}

module.exports = {
    buildMerkleRoot, buildMerkleProof, validMerkleProof,
    encodeValidBlockMerkleProof, encodeValidBlockSNARKProof,
    signProof, headerRlp
}
