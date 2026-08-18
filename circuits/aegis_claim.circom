pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/mux1.circom";

template ByteRange(n) {
    signal input in[n];
    component b[n];
    for (var i = 0; i < n; i++) {
        b[i] = Num2Bits(8);
        b[i].in <== in[i];
    }
}

template EmbeddingCommit() {
    signal input u[128];
    signal input salt;
    signal output out;

    component chunk[8];
    for (var j = 0; j < 8; j++) {
        chunk[j] = Poseidon(16);
        for (var k = 0; k < 16; k++) { chunk[j].inputs[k] <== u[16*j + k]; }
    }
    component top = Poseidon(9);
    for (var j = 0; j < 8; j++) { top.inputs[j] <== chunk[j].out; }
    top.inputs[8] <== salt;
    out <== top.out;
}

template MerkleInclusion(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal cur[depth + 1];
    cur[0] <== leaf;

    component h[depth];
    component muxL[depth];
    component muxR[depth];

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        muxL[i] = Mux1();
        muxL[i].c[0] <== cur[i];
        muxL[i].c[1] <== pathElements[i];
        muxL[i].s    <== pathIndices[i];

        muxR[i] = Mux1();
        muxR[i].c[0] <== pathElements[i];
        muxR[i].c[1] <== cur[i];
        muxR[i].s    <== pathIndices[i];

        h[i] = Poseidon(2);
        h[i].inputs[0] <== muxL[i].out;
        h[i].inputs[1] <== muxR[i].out;
        cur[i + 1] <== h[i].out;
    }
    root <== cur[depth];
}

template AegisClaim(depth) {
    signal input root;
    signal input policyId;
    signal input epoch;
    signal input tauQ;
    signal input modelHash;
    signal output nullifier;

    signal input uLive[128];
    signal input uReg[128];
    signal input salt;
    signal input idSecret;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    component rL = ByteRange(128); for (var i=0;i<128;i++) { rL.in[i] <== uLive[i]; }
    component rR = ByteRange(128); for (var i=0;i<128;i++) { rR.in[i] <== uReg[i];  }

    component ec = EmbeddingCommit();
    for (var i=0;i<128;i++) { ec.u[i] <== uReg[i]; }
    ec.salt <== salt;

    component cid = Poseidon(3);
    cid.inputs[0] <== idSecret;
    cid.inputs[1] <== ec.out;
    cid.inputs[2] <== modelHash;

    component mk = MerkleInclusion(depth);
    mk.leaf <== cid.out;
    for (var i=0;i<depth;i++) {
        mk.pathElements[i] <== pathElements[i];
        mk.pathIndices[i]  <== pathIndices[i];
    }
    root === mk.root;

    signal prods[128];
    signal acc[129];
    acc[0] <== 0;
    for (var i=0;i<128;i++) {
        prods[i] <== (uLive[i] - 128) * (uReg[i] - 128);
        acc[i+1] <== acc[i] + prods[i];
    }
    component ge = GreaterEqThan(24);
    ge.in[0] <== acc[128] + 2097152;
    ge.in[1] <== tauQ     + 2097152;
    ge.out === 1;

    component nf = Poseidon(3);
    nf.inputs[0] <== idSecret;
    nf.inputs[1] <== policyId;
    nf.inputs[2] <== epoch;
    nullifier <== nf.out;
}

component main { public [ root, policyId, epoch, tauQ, modelHash ] } = AegisClaim(20);
