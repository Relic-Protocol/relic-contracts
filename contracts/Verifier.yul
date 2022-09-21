/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

// VK layout
// 0x000 domain_size
// 0x020 omega (element)
// 0x040 gate_setup_commitments[0..6] (points)
// 0x200 gate_selector_commitments[0..1] (points)
// 0x280 copy_permutation_commitments[0..3] (points)
// 0x380 copy_permutation_non_residues[0..2] (element)
// 0x3E0 g2_x

// Proof layout (uint256[])
// 0x000 wire_commitments[0..3] (points)
// 0x100 copy_permutation_grand_product_commitment (point)
// 0x140 quotient_poly_commitments[0..3] (points)
// 0x240 wire_values_at_z[0..3] (elements)
// 0x2C0 wire_values_at_z_omega[0] (element)
// 0x2E0 gate_selector_values_at_z[0] (element)
// 0x300 permutation_polynomials_at_z[0..2] (elements)
// 0x360 copy_grand_product_at_z_omega (element)
// 0x380 quotient_polynomial_at_z (element)
// 0x3A0 linearization_polynomial_at_z (element)
// 0x3C0 opening_at_z_proof (point)
// 0x400 opening_at_z_omega_proof (point)
// 0x440 subproof_limbs[0..15] (elements)
// 0x640 num_inputs (uint)
// 0x660 inputs[...]

// Memory layout
// 0x000 Scratch space
// 0x040 Memory end pointer (unused)
// 0x060 Zero slot (unused)
// 0x080 Recursive circuit public input
// 0x0A0 Reconstructed subproof points
// 0x120 Transcript state
// 0x180 Temporary storage for transcript, field, and point operations
// 0x280 beta
// 0x2A0 gamma
// 0x2C0 alpha
// 0x2E0 z
// 0x300 domain_size
// 0x320 omega
// 0x340 l0_at_z
// 0x360 v
// 0x380 u
// 0x3A0 z_pow_domain_size
// 0x3C0 (unused)
// 0x400 Temporary storage
// 0x640 (unused)
// 0x800 Debugging stats (point multiplications)
// 0x820 Debugging stats (starting gas)
object "Verifier" {
    // constructor(uint256[35])
    code {
        let vk_size := sub(codesize(), dataoffset("vk_arg"))
        if iszero(eq(vk_size, 0x460)) {
            revert(0, 0)
        }

        let deployed_size := add(vk_size, datasize("Verifier_deployed"))

        // deploy the verification code with embedded VK
        datacopy(0, dataoffset("Verifier_deployed"), deployed_size)
        return(0, deployed_size)
    }
    object "Verifier_deployed" {
        code {
            switch selector()
            case 0x2efb216b /* verify((uint256[34],uint256[16],uint256[])) returns (bool) */ {
                mstore(0x820, gas())
                mstore(0, verify(dataoffset("vk_arg")))
                mstore(0x20, sub(mload(0x820), gas()))
                return(0, 0x40)
            }
            default {
                revert(0, 0)
            }

            function selector() -> s {
                s := div(calldataload(0), 0x100000000000000000000000000000000000000000000000000000000)
            }
            function decodeAsUint(offset) -> v {
                if lt(calldatasize(), add(offset, 0x20)) {
                    revert(0, 0)
                }
                v := calldataload(offset)
            }

            function validate(proof) {
                // validate that all user-provided field elements are < r_mod
                // validate that all user-provided points are < q_mod
                let valid := 1
                let q_mod := 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
                let r_mod := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001

                for { let i := add(proof, 0x000) } lt(i, add(proof, 0x240)) { i := add(i, 0x40) } {
                    let x := calldataload(i)
                    let y := calldataload(add(i, 0x20))
                    // x < q_mod
                    valid := and(valid, lt(x, q_mod))
                    // y < q_mod
                    valid := and(valid, lt(y, q_mod))
                    // check on curve: y^2 == x^3 + 3
                    valid := and(
                        valid,
                        eq(
                            mulmod(y, y, q_mod),
                            addmod(
                                mulmod(
                                    mulmod(x, x, q_mod),
                                    x,
                                    q_mod
                                ),
                                3,
                                q_mod
                            )
                        )
                    )
                }

                for { let i := add(proof, 0x240) } lt(i, add(proof, 0x3C0)) { i := add(i, 0x20) } {
                    // < r_mod
                    valid := and(valid, lt(calldataload(i), r_mod))
                }

                for { let i := add(proof, 0x3C0) } lt(i, add(proof, 0x440)) { i := add(i, 0x40) } {
                    let x := calldataload(i)
                    let y := calldataload(add(i, 0x20))
                    // x < q_mod
                    valid := and(valid, lt(x, q_mod))
                    // y < q_mod
                    valid := and(valid, lt(y, q_mod))
                    // check on curve: y^2 == x^3 + 3
                    valid := and(
                        valid,
                        eq(
                            mulmod(y, y, q_mod),
                            addmod(
                                mulmod(
                                    mulmod(x, x, q_mod),
                                    x,
                                    q_mod
                                ),
                                3,
                                q_mod
                            )
                        )
                    )
                }

                for { let i := add(proof, 0x440) } lt(i, add(proof, 0x640)) { i := add(i, 0x20) } {
                    // < 2^LIMB_WIDTH
                    valid := and(valid, lt(calldataload(i), 0x100000000000000000))
                }

                let inputs := add(proof, calldataload(add(proof, 0x640)))
                let len := mul(0x20, calldataload(inputs))
				inputs := add(inputs, 0x20)
                let end := add(inputs, len)
                for { let i := inputs } lt(i, end) { i := add(i, 0x20) } {
                    // < r_mod
                    valid := and(valid, lt(calldataload(i), r_mod))
                }

                if iszero(valid) {
                    revert(0, 0)
                }
            }
            function verify(vk) -> output {
                let proof := add(4, calldataload(4))
                validate(proof)

                // Reconstruct recursive circuit public input (stored at 0x80)
                // SHA256(input[0] || ... || input[N-1] || subproof_limbs[0] || ... || subproof_limbs[N-1])
                {
					let inputs := add(proof, calldataload(add(proof, 0x640)))
					let len := 0
					len := mul(0x20, calldataload(inputs))
					inputs := add(inputs, 0x20)
                    calldatacopy(0x80, inputs, len)
                    calldatacopy(add(0x80, len), add(proof, 0x440), 0x200)
                    if iszero(staticcall(gas(), 0x2, 0x80, add(0x200, len), 0x00, 0x20)) {
                        revert(0, 0)
                    }
                    mstore(0x80, and(mload(0x0), 0x00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff))
                }

                // Reconstruct subproof points (stored at 0xA0 - 0x120)
                {
                    let x1 := calldataload(add(proof, 0x440))
                    let x2 := calldataload(add(proof, 0x460))
                    let x3 := calldataload(add(proof, 0x480))
                    let x4 := calldataload(add(proof, 0x4A0))
                    if shr(68, or(or(x1, x2), or(x3, x4))) {
                        revert(0, 0)
                    }
                    mstore(0xA0, or(or(x1, shl(68, x2)), or(shl(136, x3), shl(204, x4))))
                }
                {
                    let x1 := calldataload(add(proof, 0x4C0))
                    let x2 := calldataload(add(proof, 0x4E0))
                    let x3 := calldataload(add(proof, 0x500))
                    let x4 := calldataload(add(proof, 0x520))
                    if shr(68, or(or(x1, x2), or(x3, x4))) {
                        revert(0, 0)
                    }
                    mstore(0xC0, or(or(x1, shl(68, x2)), or(shl(136, x3), shl(204, x4))))
                }
                {
                    let x1 := calldataload(add(proof, 0x540))
                    let x2 := calldataload(add(proof, 0x560))
                    let x3 := calldataload(add(proof, 0x580))
                    let x4 := calldataload(add(proof, 0x5A0))
                    if shr(68, or(or(x1, x2), or(x3, x4))) {
                        revert(0, 0)
                    }
                    mstore(0xE0, or(or(x1, shl(68, x2)), or(shl(136, x3), shl(204, x4))))
                }
                {
                    let x1 := calldataload(add(proof, 0x5C0))
                    let x2 := calldataload(add(proof, 0x5E0))
                    let x3 := calldataload(add(proof, 0x600))
                    let x4 := calldataload(add(proof, 0x620))
                    if shr(68, or(or(x1, x2), or(x3, x4))) {
                        revert(0, 0)
                    }
                    mstore(0x100, or(or(x1, shl(68, x2)), or(shl(136, x3), shl(204, x4))))
                }

                // Validate reconstructed subproof points
                {
                    let valid := 1
                    let q_mod := 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
                    for { let i := 0x0A0 } lt(i, 0x120) { i := add(i, 0x40) } {
                        let x := mload(i)
                        let y := mload(add(i, 0x20))
                        // x < q_mod
                        valid := and(valid, lt(x, q_mod))
                        // y < q_mod
                        valid := and(valid, lt(y, q_mod))
                        // check on curve: y^2 == x^3 + 3
                        valid := and(
                            valid,
                            eq(
                                mulmod(y, y, q_mod),
                                addmod(
                                    mulmod(
                                        mulmod(x, x, q_mod),
                                        x,
                                        q_mod
                                    ),
                                    3,
                                    q_mod
                                )
                            )
                        )
                    }

                    if iszero(valid) {
                        revert(0, 0)
                    }
                }

                // Transcript state (memory at 0x120 - 0x180)
                // 0x120 state_0
                // 0x140 state_1
                // 0x160 challenge_counter

                // Temporary storage (memory at 0x180 - 0x280)

                function new_transcript() {
                    mstore(0x120, 0)
                    mstore(0x140, 0)
                    mstore(0x160, 0)
                }
                function update_transcript(value) {
                    mstore(0x180, 0)
                    mstore(0x184, mload(0x120))
                    mstore(0x1A4, mload(0x140))
                    mstore(0x1C4, value)

                    mstore(0x120, keccak256(0x180, 0x64))
                    mstore8(0x183, 1)
                    mstore(0x140, keccak256(0x180, 0x64))
                }
                function get_challenge() -> result {
                    let counter := mload(0x160)
                    mstore(0x160, add(counter, 1))

                    mstore(0x1A8, counter)
                    mstore(0x180, 0)
                    mstore8(0x183, 2)
                    mstore(0x184, mload(0x120))
                    mstore(0x1A4, mload(0x140))
                    result := and(keccak256(0x180, 0x48), 0x1fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff)
                }

                // Field operations
                function ff_inverse(value) -> result {
                    if iszero(value) {
                        revert(0, 0)
                    }
                    result := ff_pow(value, 21888242871839275222246405745257275088548364400416034343698204186575808495615)
                }
                function ff_add(a, b) -> result {
                    result := addmod(a, b, 21888242871839275222246405745257275088548364400416034343698204186575808495617)
                }
                function ff_sub(a, b) -> result {
                    let r_mod := 21888242871839275222246405745257275088548364400416034343698204186575808495617
                    result := addmod(a, sub(r_mod, b), r_mod)
                }
                function ff_mul(a, b) -> result {
                    result := mulmod(a, b, 21888242871839275222246405745257275088548364400416034343698204186575808495617)
                }
                function ff_pow(value, power) -> result {
                    mstore(0x180, 32)
                    mstore(0x1A0, 32)
                    mstore(0x1C0, 32)
                    mstore(0x1E0, value)
                    mstore(0x200, power)
                    mstore(0x220, 21888242871839275222246405745257275088548364400416034343698204186575808495617)
                    if iszero(staticcall(gas(), 0x5, 0x180, 0xc0, 0x0, 0x20)) {
                        revert(0, 0)
                    }
                    result := mload(0)
                }
                function point_add(ax, ay, bx, by) -> cx, cy {
                    switch and(iszero(bx), iszero(by))
                    case 1 {
                        cx := ax
                        cy := ay
                    }
                    default {
                        switch and(iszero(ax), iszero(ay))
                        case 1 {
                            cx := bx
                            cy := by
                        }
                        default {
                            mstore(0x180, ax)
                            mstore(0x1a0, ay)
                            mstore(0x1c0, bx)
                            mstore(0x1e0, by)
                            if iszero(staticcall(gas(), 0x6, 0x180, 0x80, 0, 0x40)) {
                                revert(0, 0)
                            }
                            cx := mload(0)
                            cy := mload(0x20)
                        }
                    }
                }
                function point_sub(ax, ay, bx, by) -> cx, cy {
                    switch and(iszero(bx), iszero(by))
                    case 1 {
                        cx := ax
                        cy := ay
                    }
                    default {
                        switch and(iszero(ax), iszero(ay))
                        case 1 {
                            cx := bx
                            cy := sub(21888242871839275222246405745257275088696311157297823662689037894645226208583, by)
                        }
                        default {
                            mstore(0x180, ax)
                            mstore(0x1a0, ay)
                            mstore(0x1c0, bx)
                            mstore(0x1e0, sub(21888242871839275222246405745257275088696311157297823662689037894645226208583, by))
                            if iszero(staticcall(gas(), 0x6, 0x180, 0x80, 0, 0x40)) {
                                revert(0, 0)
                            }
                            cx := mload(0)
                            cy := mload(0x20)
                        }
                    }
                }
                mstore(0x800, 0)
                function point_mul(ax, ay, s) -> cx, cy {
                    let starting_gas := gas()
                    mstore(0x180, ax)
                    mstore(0x1a0, ay)
                    mstore(0x1c0, s)
                    if iszero(staticcall(gas(), 0x7, 0x180, 0x60, 0, 0x40)) {
                        revert(0, 0)
                    }
                    cx := mload(0)
                    cy := mload(0x20)
                    mstore(0x800, add(mload(0x800), 1))
                }
                function point_negate(x, y) -> nx, ny {
                    switch iszero(y)
                    case 1 {
                        if iszero(iszero(x)) {
                            revert(0, 0)
                        }
                        nx := x
                        ny := y
                    }
                    default {
                        nx := x
                        ny := sub(21888242871839275222246405745257275088696311157297823662689037894645226208583, y)
                    }
                }

                // verify_initial
                // 0x280 beta
                // 0x2A0 gamma
                // 0x2C0 alpha
                // 0x2E0 z
                // 0x300 domain_size
                // 0x320 omega
                // 0x340 l0_at_z
                // 0x360 v
                // 0x380 u
                // 0x3A0 z_pow_domain_size
                // ...
                // 0x400 temp for vk
                new_transcript()
                update_transcript(mload(0x80))
                for { let i := 0x000 } lt(i, 0x100) { i := add(i, 0x20) } {
                    update_transcript(calldataload(add(proof, i)))
                }
                mstore(0x280, get_challenge())
                mstore(0x2A0, get_challenge())

                update_transcript(calldataload(add(proof, 0x100)))
                update_transcript(calldataload(add(proof, 0x120)))
                mstore(0x2C0, get_challenge())

                for { let i := 0x140 } lt(i, 0x240) { i := add(i, 0x20) } {
                    update_transcript(calldataload(add(proof, i)))
                }
                mstore(0x2E0, get_challenge())

                // get domain_size and omega
                codecopy(0x300, add(vk, 0x000), 0x40)

                // evaluate lagrange point 0 at z
                {
                    let at := mload(0x2E0)
                    let domain_size := mload(0x300)
                    let z_pow_domain_size := ff_pow(at, domain_size)
                    mstore(0x3A0, z_pow_domain_size)
                    let num := ff_sub(z_pow_domain_size, 1)
                    if iszero(num) {
                        revert(0, 0)
                    }
                    // omega^0 == 1, num * omega^0 == num
                    // num := ff_mul(num, ff_pow(omega, 0))
                    let den := ff_inverse(ff_mul(ff_sub(at, 1), domain_size))
                    mstore(0x340, ff_mul(num, den))
                }

                update_transcript(calldataload(add(proof, 0x380)))
                for { let i := 0x240 } lt(i, 0x380) { i := add(i, 0x20) } {
                    update_transcript(calldataload(add(proof, i)))
                }
                update_transcript(calldataload(add(proof, 0x3A0)))

                mstore(0x360, get_challenge())
                for { let i := 0x3C0 } lt(i, 0x440) { i := add(i, 0x20) } {
                    update_transcript(calldataload(add(proof, i)))
                }
                mstore(0x380, get_challenge())

                // verify at z
                {
                    let rhs := calldataload(add(proof, 0x3A0))
                    {
                        let inputs_term := ff_mul(mload(0x340), mload(0x80))
                        rhs := ff_add(rhs, ff_mul(inputs_term, calldataload(add(proof, 0x2E0))))
                    }

                    let alpha := mload(0x2C0)
                    let alpha_pow_2 := ff_mul(alpha, alpha)
                    let quotient_challenge := ff_mul(ff_mul(alpha_pow_2, alpha_pow_2), alpha)
                    {
                        let z_part := calldataload(add(proof, 0x360))
                        for { let i := 0x0 } lt(i, 0x60) { i := add(i, 0x20) } {
                            let tmp := calldataload(add(proof, add(i, 0x300)))
                            tmp := ff_mul(tmp, mload(0x280))
                            tmp := ff_add(tmp, mload(0x2A0))
                            tmp := ff_add(tmp, calldataload(add(proof, add(i, 0x240))))
                            z_part := ff_mul(z_part, tmp)
                        }

                        {
                            let tmp := ff_add(mload(0x2A0), calldataload(add(proof, 0x2A0)))
                            z_part := ff_mul(z_part, tmp)
                            z_part := ff_mul(z_part, quotient_challenge)
                            rhs := ff_sub(rhs, z_part)
                        }
                    }
                    
                    quotient_challenge := ff_mul(quotient_challenge, alpha)
                    {
                        let tmp := ff_mul(mload(0x340), quotient_challenge)
                        rhs := ff_sub(rhs, tmp)
                    }

                    // let lhs := evaluate_vanishing(mload(0x300), mload(0x2E0))
                    let lhs := ff_sub(mload(0x3A0), 1)
                    if iszero(lhs) {
                        revert(0, 0)
                    }
                    lhs := ff_mul(lhs, calldataload(add(proof, 0x380)))
                    if iszero(eq(lhs, rhs)) {
                        revert(0, 0)
                    }
                }

                // aggregate_commitments

                // reconstruct_linearization_commitment
                let dx, dy
                {
                    codecopy(0x400, add(vk, 0x40), 0x240)
                    let resx := mload(0x540)
                    let resy := mload(0x560)

                    // addition gates
                    {
                        let j := 0x400
                        for { let i := 0x240 } lt(i, 0x2C0) { i := add(i, 0x20) } {
                            let px, py := point_mul(mload(j), mload(add(j, 0x20)), calldataload(add(proof, i)))
                            resx, resy := point_add(resx, resy, px, py)
                            j := add(j, 0x40)
                        }
                    }

                    // multiplication gate
                    {
                        let tmp := ff_mul(calldataload(add(proof, 0x240)), calldataload(add(proof, 0x260)))
                        let px, py := point_mul(mload(0x500), mload(0x520), tmp)
                        resx, resy := point_add(resx, resy, px, py)
                    }

                    // d_next
                    {
                        let px, py := point_mul(mload(0x580), mload(0x5a0), calldataload(add(proof, 0x2C0)))
                        resx, resy := point_add(resx, resy, px, py)
                    }

                    // multiply by main gate selector
                    resx, resy := point_mul(resx, resy, calldataload(add(proof, 0x2E0)))

                    // XXX verified x and y, 109227 gas

                    // contribution from range check gate
                    let alpha := mload(0x2C0)
                    let current_alpha := 1
                    {
                        let rangeres := 0
                        for { let i := 0 } lt(i, 3) { i := add(i, 1) } {
                            current_alpha := ff_mul(current_alpha, alpha)

                            let t0 := calldataload(add(proof, sub(0x2A0, mul(i, 32))))
                            t0 := ff_mul(t0, 4)

                            let t1 := calldataload(add(proof, sub(0x280, mul(i, 32))))
                            t1 := ff_sub(t1, t0)

                            let t2 := t1
                            t2 := ff_mul(t2, ff_sub(t1, 1))
                            t2 := ff_mul(t2, ff_sub(t1, 2))
                            t2 := ff_mul(t2, ff_sub(t1, 3))
                            t2 := ff_mul(t2, current_alpha)
                            rangeres := ff_add(rangeres, t2)
                        }

                        {
                            current_alpha := ff_mul(current_alpha, alpha)
                            let t0 := calldataload(add(proof, 0x240))
                            t0 := ff_mul(t0, 4)

                            let t1 := calldataload(add(proof, 0x2C0))
                            t1 := ff_sub(t1, t0)

                            let t2 := t1
                            t2 := ff_mul(t2, ff_sub(t1, 1))
                            t2 := ff_mul(t2, ff_sub(t1, 2))
                            t2 := ff_mul(t2, ff_sub(t1, 3))
                            t2 := ff_mul(t2, current_alpha)
                            rangeres := ff_add(rangeres, t2)
                        }

                        let px, py := point_mul(mload(0x600), mload(0x620), rangeres)
                        resx, resy := point_add(resx, resy, px, py)
                    }
                    current_alpha := ff_mul(current_alpha, alpha)
                    // copy permutation
                    {
                        codecopy(0x400, add(vk, 0x340), 0xA0)
                        let beta := mload(0x280)
                        let gamma := mload(0x2A0)
                        let grand_product_part_at_z := gamma
                        {
                            let z_beta := ff_mul(mload(0x2E0), beta)
                            grand_product_part_at_z := ff_add(grand_product_part_at_z, ff_add(z_beta, calldataload(add(proof, 0x240))))
                            for { let i := 0 } lt(i, 0x60) { i := add(i, 0x20) } {
                                // FIXME: this can be optimized
                                let tmp := ff_mul(z_beta, mload(add(0x440, i)))
                                tmp := ff_add(tmp, gamma)
                                tmp := ff_add(tmp, calldataload(add(proof, add(0x260, i))))
                                grand_product_part_at_z := ff_mul(grand_product_part_at_z, tmp)
                            }
                        }
                        grand_product_part_at_z := ff_mul(grand_product_part_at_z, current_alpha)
                        {
                            let tmp := ff_mul(mload(0x340), ff_mul(current_alpha, alpha))
                            grand_product_part_at_z := ff_add(grand_product_part_at_z, tmp)
                        }
                        {
                            let last_permutation_part_at_z := ff_mul(beta, ff_mul(calldataload(add(proof, 0x360)), current_alpha))
                            for { let i := 0 } lt(i, 0x60) { i := add(i, 0x20) } {
                                let tmp := ff_mul(beta, calldataload(add(proof, add(0x300, i))))
                                tmp := ff_add(tmp, gamma)
                                tmp := ff_add(tmp, calldataload(add(proof, add(0x240, i))))
                                last_permutation_part_at_z := ff_mul(tmp, last_permutation_part_at_z)
                            }
                            let px, py := point_mul(calldataload(add(proof, 0x100)), calldataload(add(proof, 0x120)), grand_product_part_at_z)
                            {
                                let px2, py2 := point_mul(mload(0x400), mload(0x420), last_permutation_part_at_z)
                                px, py := point_sub(px, py, px2, py2)
                            }
                            resx, resy := point_add(resx, resy, px, py)
                        }
                    }
                    dx := resx
                    dy := resy
                }
                // continue aggregate commitments
                {
                    let z_in_domain_size := mload(0x3A0)
                    let aggregation_challenge := 1
                    let v := mload(0x360)
                    let pair_with_generator_x := calldataload(add(proof, 0x140))
                    let pair_with_generator_y := calldataload(add(proof, 0x160))

                    {
                        let tmp := 1
                        for { let i := 0x180 } lt(i, 0x240) { i := add(i, 0x40) } {
                            tmp := ff_mul(tmp, z_in_domain_size)
                            let px, py := point_mul(calldataload(add(proof, i)), calldataload(add(proof, add(i, 0x20))), tmp)
                            pair_with_generator_x, pair_with_generator_y := point_add(pair_with_generator_x, pair_with_generator_y, px, py)
                        }
                    }

                    {
                        aggregation_challenge := ff_mul(aggregation_challenge, v)
                        let px, py := point_mul(dx, dy, aggregation_challenge)
                        pair_with_generator_x, pair_with_generator_y := point_add(pair_with_generator_x, pair_with_generator_y, px, py)
                    }

                    for { let i := 0x0 } lt(i, 0x100) { i := add(i, 0x40) } {
                        aggregation_challenge := ff_mul(aggregation_challenge, v)
                        let px, py := point_mul(calldataload(add(proof, i)), calldataload(add(proof, add(i, 0x20))), aggregation_challenge)
                        pair_with_generator_x, pair_with_generator_y := point_add(pair_with_generator_x, pair_with_generator_y, px, py)
                    }

                    codecopy(0x400, add(vk, 0x200), 0x180)
                    {
                        aggregation_challenge := ff_mul(aggregation_challenge, v)
                        let px, py := point_mul(mload(0x400), mload(0x420), aggregation_challenge)
                        pair_with_generator_x, pair_with_generator_y := point_add(pair_with_generator_x, pair_with_generator_y, px, py)
                    }
                    for { let i := 0x480 } lt(i, 0x540) { i := add(i, 0x40) } {
                        aggregation_challenge := ff_mul(aggregation_challenge, v)
                        let px, py := point_mul(mload(i), mload(add(i, 0x20)), aggregation_challenge)
                        pair_with_generator_x, pair_with_generator_y := point_add(pair_with_generator_x, pair_with_generator_y, px, py)
                    }

                    aggregation_challenge := ff_mul(aggregation_challenge, v)
                    // now do prefactor for grand_product(x*omega)
                    {
                        let tmp := ff_mul(aggregation_challenge, mload(0x380))
                        let px, py := point_mul(calldataload(add(proof, 0x100)), calldataload(add(proof, 0x120)), tmp)
                        pair_with_generator_x, pair_with_generator_y := point_add(pair_with_generator_x, pair_with_generator_y, px, py)
                    }
                    aggregation_challenge := ff_mul(aggregation_challenge, v)
                    {
                        let tmp := ff_mul(aggregation_challenge, mload(0x380))
                        let px, py := point_mul(calldataload(add(proof, 0xc0)), calldataload(add(proof, 0xe0)), tmp)
                        pair_with_generator_x, pair_with_generator_y := point_add(pair_with_generator_x, pair_with_generator_y, px, py)
                    }

                    let aggregated_value := calldataload(add(proof, 0x380))
                    aggregation_challenge := v
                    {
                        let tmp := ff_mul(calldataload(add(proof, 0x3A0)), aggregation_challenge)
                        aggregated_value := ff_add(aggregated_value, tmp)
                    }
                    for { let i := 0x240 } lt(i, 0x2C0) { i := add(i, 0x20) } {
                        aggregation_challenge := ff_mul(aggregation_challenge, v)
                        let tmp := ff_mul(calldataload(add(proof, i)), aggregation_challenge)
                        aggregated_value := ff_add(aggregated_value, tmp)
                    }
                    for { let i := 0x2E0 } lt(i, 0x360) { i := add(i, 0x20) } {
                        aggregation_challenge := ff_mul(aggregation_challenge, v)
                        let tmp := ff_mul(calldataload(add(proof, i)), aggregation_challenge)
                        aggregated_value := ff_add(aggregated_value, tmp)
                    }
                    aggregation_challenge := ff_mul(aggregation_challenge, v)
                    {
                        let tmp := ff_mul(calldataload(add(proof, 0x360)), aggregation_challenge)
                        tmp := ff_mul(tmp, mload(0x380))
                        aggregated_value := ff_add(aggregated_value, tmp)
                    }
                    aggregation_challenge := ff_mul(aggregation_challenge, v)
                    {
                        let tmp := ff_mul(calldataload(add(proof, 0x2C0)), aggregation_challenge)
                        tmp := ff_mul(tmp, mload(0x380))
                        aggregated_value := ff_add(aggregated_value, tmp)
                    }
                    {
                        let px, py := point_mul(1, 2, aggregated_value)
                        pair_with_generator_x, pair_with_generator_y := point_sub(pair_with_generator_x, pair_with_generator_y, px, py)
                        px, py := point_mul(calldataload(add(proof, 0x3C0)), calldataload(add(proof, 0x3E0)), mload(0x2E0))
                        pair_with_generator_x, pair_with_generator_y := point_add(pair_with_generator_x, pair_with_generator_y, px, py)
                        let tmp := ff_mul(mload(0x320), ff_mul(mload(0x380), mload(0x2E0)))
                        px, py := point_mul(calldataload(add(proof, 0x400)), calldataload(add(proof, 0x420)), tmp)
                        pair_with_generator_x, pair_with_generator_y := point_add(pair_with_generator_x, pair_with_generator_y, px, py)
                    }
                    let pair_with_x_x, pair_with_x_y := point_mul(calldataload(add(proof, 0x400)), calldataload(add(proof, 0x420)), mload(0x380))
                    pair_with_x_x, pair_with_x_y := point_add(pair_with_x_x, pair_with_x_y, calldataload(add(proof, 0x3C0)), calldataload(add(proof, 0x3E0)))
                    pair_with_x_x, pair_with_x_y := point_negate(pair_with_x_x, pair_with_x_y)

                    // combine_inner_and_outer
                    {
                        new_transcript()
                        update_transcript(mload(0xA0))
                        update_transcript(mload(0xC0))
                        update_transcript(mload(0xE0))
                        update_transcript(mload(0x100))
                        update_transcript(pair_with_generator_x)
                        update_transcript(pair_with_generator_y)
                        update_transcript(pair_with_x_x)
                        update_transcript(pair_with_x_y)
                        let challenge := get_challenge()
                        pair_with_generator_x, pair_with_generator_y := point_mul(pair_with_generator_x, pair_with_generator_y, challenge)
                        pair_with_generator_x, pair_with_generator_y := point_add(pair_with_generator_x, pair_with_generator_y, mload(0xA0), mload(0xC0))
                        pair_with_x_x, pair_with_x_y := point_mul(pair_with_x_x, pair_with_x_y, challenge)
                        pair_with_x_x, pair_with_x_y := point_add(pair_with_x_x, pair_with_x_y, mload(0xE0), mload(0x100))
                    }

                    // pairing
                    {
                        mstore(0x400, pair_with_generator_x)
                        mstore(0x420, pair_with_generator_y)
                        mstore(0x440, 0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2)
                        mstore(0x460, 0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed)
                        mstore(0x480, 0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b)
                        mstore(0x4A0, 0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa)
                        mstore(0x4C0, pair_with_x_x)
                        mstore(0x4E0, pair_with_x_y)
                        codecopy(0x500, add(vk, 0x3E0), 0x80)
                        if iszero(staticcall(gas(), 8, 0x400, 0x180, 0, 0x20)) {
                            revert(0, 0)
                        }
                        output := iszero(iszero(mload(0)))
                        //output := mload(0x800)
                    }
                }
           }
        }
        data "vk_arg" "" // same offset as vk_arg below
    }
    data "vk_arg" "" // offset of first constructor argument (the VK), will be copied into deployed bytecode
}
