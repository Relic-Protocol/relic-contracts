/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

/**
 * @title Merkle Tree
 * @author Theori, Inc.
 * @notice Gas optimized SHA256 Merkle tree code.
 */
library MerkleTree {
    /**
     * @notice performs one merkle combination of two node hashes
     */
    function combine(bytes32 left, bytes32 right) internal view returns (bytes32 result) {
        assembly {
            mstore(0, left)
            mstore(0x20, right)
            // compute sha256
            if iszero(staticcall(gas(), 0x2, 0x0, 0x40, 0x0, 0x20)) {
                revert(0, 0)
            }
            result := mload(0)
        }
    }

    /**
     * @notice computes a SHA256 merkle root of the provided hashes, in place
     * @param temp the mutable array of hashes
     * @return the merkle root hash
     */
    function computeRoot(bytes32[] memory temp) internal view returns (bytes32) {
        uint256 count = temp.length;
        assembly {
            // repeat until we arrive at one root hash
            for {

            } gt(count, 1) {

            } {
                let dataElementLocation := add(temp, 0x20)
                let hashElementLocation := add(temp, 0x20)
                for {
                    let i := 0
                } lt(i, count) {
                    i := add(i, 2)
                } {
                    if iszero(
                        staticcall(gas(), 0x2, hashElementLocation, 0x40, dataElementLocation, 0x20)
                    ) {
                        revert(0, 0)
                    }
                    dataElementLocation := add(dataElementLocation, 0x20)
                    hashElementLocation := add(hashElementLocation, 0x40)
                }
                count := shr(1, count)
            }
        }
        return temp[0];
    }

    /**
     * @notice compute the root of the merkle tree according to the proof
     * @param index the index of the node to check
     * @param leaf the leaf to check
     * @param proofHashes the proof, i.e. the sequence of siblings from the
     *        node to root
     */
    function proofRoot(
        uint256 index,
        bytes32 leaf,
        bytes32[] calldata proofHashes
    ) internal view returns (bytes32 result) {
        assembly {
            result := leaf
            let start := proofHashes.offset
            let end := add(start, mul(proofHashes.length, 0x20))
            for {
                let ptr := start
            } lt(ptr, end) {
                ptr := add(ptr, 0x20)
            } {
                let proofHash := calldataload(ptr)

                // use scratch space (0x0 - 0x40) for hash input
                switch and(index, 1)
                case 0 {
                    mstore(0x0, result)
                    mstore(0x20, proofHash)
                }
                case 1 {
                    mstore(0x0, proofHash)
                    mstore(0x20, result)
                }

                // compute sha256
                if iszero(staticcall(gas(), 0x2, 0x0, 0x40, 0x0, 0x20)) {
                    revert(0, 0)
                }
                result := mload(0x0)

                index := shr(1, index)
            }
        }
        require(index == 0, "invalid index for proof");
    }

    /**
     * @notice compute the root of the merkle tree containing the given leaf
     *         at index 0 and default values for all other leaves
     * @param depth the depth of the tree
     * @param leaf the non-default leaf
     * @param defaultLeaf the default leaf for all other positions
     */
    function rootWithDefault(
        uint256 depth,
        bytes32 leaf,
        bytes32 defaultLeaf
    ) internal view returns (bytes32 result) {
        assembly {
            result := leaf
            // the default value will live at 0x20 and be updated each iteration
            mstore(0x20, defaultLeaf)
            for { } depth { depth := sub(depth, 1) } {
                // compute sha256 of result || default
                mstore(0x0, result)
                if iszero(staticcall(gas(), 0x2, 0x0, 0x40, 0x0, 0x20)) {
                    revert(0, 0)
                }
                result := mload(0x0)
                if iszero(depth) {
                    break
                }

                // compute sha256 of default || default
                mstore(0x0, mload(0x20))
                if iszero(staticcall(gas(), 0x2, 0x0, 0x40, 0x20, 0x20)) {
                    revert(0, 0)
                }
            }
        }
    }

    /**
     * @notice check if a hash is in the merkle tree for rootHash
     * @param rootHash the merkle root
     * @param index the index of the node to check
     * @param hash the hash to check
     * @param proofHashes the proof, i.e. the sequence of siblings from the
     *        node to root
     */
    function validProof(
        bytes32 rootHash,
        uint256 index,
        bytes32 hash,
        bytes32[] calldata proofHashes
    ) internal view returns (bool result) {
        return rootHash == proofRoot(index, hash, proofHashes);
    }
}
