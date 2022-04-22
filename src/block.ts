import hash, { blockSize } from "fast-sha256";
import { broadcast, all_sockets, socket_error } from "./socket";
import { canonicalize, canonicalizeEx } from 'json-canonicalize';
import {hash_string, is_hex} from "./helpers";
import { has_object, get_object } from "./db";
import { send_getobject } from "./object";
import { validate_coinbase } from "./transaction";
import { validate_UTXO } from "./utxo";


const coinbase_reward = 50e12;

export async function receive_block(data: any, socket: any) {
    console.log(
        `Received block message from : ${socket.remoteAddress}:${socket.remotePort}`
    );
    validate_block(data, socket);
}

export async function validate_block(data:any, socket:any){
    let blockid = hash_string(canonicalize(data));
    // if (!data.hasOwnProperty("T") || data.T != "00000002af000000000000000000000000000000000000000000000000000000"){
    //     socket_error(data, socket, "Block does not have valid target.");
    //     return false;
    // }
    // Check proof of work
    // if (!valid_pow(data, blockid, socket)) return false;
    if (!data.hasOwnProperty("created") || typeof data.created != "number"){
        socket_error(data, socket, "Block does not have a valid timestamp.");
        return false;
    }
    if (!data.hasOwnProperty("txids") || !Array.isArray(data.txids)){
        socket_error(data, socket, "Block does not have a valid list of txids.");
        return false;
    }
    if (!data.hasOwnProperty("nonce") || !is_hex(data.nonce, socket) || data.nonce.length != 64){
        socket_error(data, socket, "Block does not have a valid nonce.");
        return false;
    }
    if (!data.hasOwnProperty("previd")){
        socket_error(data, socket, "Block does not have a valid previd.");
        return false;
    } 
    if (data.previd == null){
        if (!validate_genesis(data, socket)) return false;
    }
    else if ((!is_hex(data.previd, socket) || data.previd.length != 64)){
        socket_error(data, socket, "Block does not have a valid previd.");
        return false;
    }
    if (data.hasOwnProperty("miner") && (typeof data.miner != "string" || data.miner.length > 128)){
        socket_error(data, socket, "Block has an invalid miner.");
        return false;
    }
    if (data.hasOwnProperty("note") && (typeof data.note != "string" || data.note.length > 128)){
        socket_error(data, socket, "Block has an invalid note.");
        return false;
    }
    // validate all txids
    if (!await validate_txids(data, socket)) return false;
    else {
        if (! await validate_UTXO(data.previd, blockid, data.txids, socket)){
            socket_error(data, socket, "Block does not have valid UTXO.");
            return false;
        }
    }

    console.log("completed") //TODO : delete

}

function valid_pow(block: any, blockid:string, socket: any,) {
    let blockid_num = parseInt(blockid, 16);
    let target_num = parseInt(block.T, 16);
    if (blockid_num >= target_num){
        socket_error(block, socket, "Block does not meet proof of work requirements.");
        return false;
    }
    return true;
}

async function validate_txids(block:any, socket:any) {
    // TODO: wait til others get back with object or error?
    // send getobject if txid is not in db
    for (let txid of block.txids){
        await send_getobject(txid, socket);
    }
    // confirm all txids are in the database
    for (let txid of block.txids){
        if (!await has_object(txid)){
            socket_error(block, socket, "Block contains an invalid txid.");
            return false;
        }
    }
    //check if first is a coinbase
    for (let i=0; i<block.txids.length; i++){
        let txid = block.txids[i];
        let tx = JSON.parse(await get_object(txid));
        if ((!tx.hasOwnProperty("inputs")) && (tx.hasOwnProperty("height"))){
            // if coinbase is not the first
            if (i != 0){
                socket_error(block, socket, "Coinbase transaction is not the first transaction in the block.");
                return false;
            }
            if (!validate_coinbase(tx, socket)) return false;
            if (!await validate_coinbase_conservation(block, tx, socket)) return false;
        }
    }
    return true;

}

//  validate law of conservation for the coinbase
async function validate_coinbase_conservation(block: any, coinbase_tx:any, socket: any) {
    
    let max = coinbase_reward;
    for (let i=1; i<block.txids.length; i++){
        let txid = block.txids[i];
        let tx = JSON.parse(await get_object(txid));
        if (tx.hasOwnProperty("inputs")){
            for (let input of tx.inputs){
                let prev_tx = JSON.parse(await get_object(input.outpoint.txid));
                let prev_output = prev_tx.outputs[input.outpoint.index];
                max -= prev_output.value;
            }
        }
        for (let output of tx.outputs){
            max += output.value;
        }
    }
    if (coinbase_tx.outputs[0].value > max){
        socket_error(block, socket, "Coinbase transaction does not meet conservation requirements.");
        return false;
    }
    return true;
}

function validate_genesis(data: any, socket: any) {
    // TODO: validation needed?
    return true;
}



let block1_fake_transaction = {
    "height": 1,
    "outputs": [{
        "pubkey": "8dbcd2401c89c04d6e53c81c90aa0b551cc8fc47c0469217c8f5cfbae1e911f9",
        "value": 500000000000000000000000000000000000
    }],
    "type": "transaction"
}

let block1_transaction = {
    "height": 0,
    "outputs": [{
        "pubkey": "8dbcd2401c89c04d6e53c81c90aa0b551cc8fc47c0469217c8f5cfbae1e911f9",
        "value": 50000000000
    }],
    "type": "transaction"
}

let trans_2 = { 
    "type": "transaction", 
    "inputs": [ { 
        "outpoint": { 
            "txid": "1bb37b637d07100cd26fc063dfd4c39a7931cc88dae3417871219715a5e374af", 
            "index": 0 
        }, 
        "sig": "3869a9ea9e7ed926a7c8b30fb71f6ed151a132b03fd5dae764f015c98271000e7da322dbcfc97af7931c23c0fae060e102446ccff0f54ec00f9978f3a69a6f0f" } ], 
        "outputs": [ { "pubkey": "077a2683d776a71139fd4db4d00c16703ba0753fc8bdc4bd6fc56614e659cde3", "value": 51000 } ] }
// let x = validate_block(JSON.parse(), null);
console.log(hash_string(canonicalize(trans_2)));
// console.log(x);