const fs = require("fs");

const proof = JSON.parse(
    fs.readFileSync("proof.json", "utf8")
);

const pub = JSON.parse(
    fs.readFileSync("public.json", "utf8")
);

const solidity = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library ProofFixture {
    function proofA() internal pure returns (uint256[2] memory a) {
        a[0] = ${proof.pi_a[0]};
        a[1] = ${proof.pi_a[1]};
    }

    function proofB() internal pure returns (uint256[2][2] memory b) {
        b[0][0] = ${proof.pi_b[0][0]};
        b[0][1] = ${proof.pi_b[0][1]};
        b[1][0] = ${proof.pi_b[1][0]};
        b[1][1] = ${proof.pi_b[1][1]};
    }

    function proofC() internal pure returns (uint256[2] memory c) {
        c[0] = ${proof.pi_c[0]};
        c[1] = ${proof.pi_c[1]};
    }

    function publicSignals()
        internal
        pure
        returns (uint256[6] memory input)
    {
        input[0] = ${pub[0]};
        input[1] = ${pub[1]};
        input[2] = ${pub[2]};
        input[3] = ${pub[3]};
        input[4] = ${pub[4]};
        input[5] = ${pub[5]};
    }
}
`;

fs.writeFileSync("test/ProofFixture.sol", solidity);

console.log("ProofFixture.sol created successfully.");
