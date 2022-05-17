import hash, { blockSize } from "fast-sha256";
import { broadcast, all_sockets, socket_error, send_format } from "./socket";
import { canonicalize, canonicalizeEx } from 'json-canonicalize';
import { hash_string, is_hex} from "./helpers";
import { has_object, get_object } from "./db";
import { send_getobject } from "./object";
import { validate_coinbase } from "./transaction";
import { validate_UTXO } from "./utxo";
import { isNumberObject } from "util/types";
import { stringify } from "querystring";


const coinbase_reward = 50e12;
export const checking_previd = new Set();
let chain_tip:any = null;
let max_height:number = 0;

export async function receive_block(data: any, socket: any) {
    console.log(
        `Received block message from : ${socket.remoteAddress}:${socket.remotePort}`
    );
    validate_block(data, socket);
}

export async function validate_block(data:any, socket:any){
    let blockid = hash_string(canonicalize(data));
    if (!data.hasOwnProperty("T") || data.T != "00000002af000000000000000000000000000000000000000000000000000000"){
        socket_error(data, socket, "Block does not have valid target.");
        return false;
    }
    // Check proof of work
    // if (!valid_pow(data, blockid, socket)) return false; //TODO: uncomment
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
    } else {
        if ((!is_hex(data.previd, socket) || data.previd.length != 64)){
            socket_error(data, socket, "Block does not have a valid previd.");
            return false;
        } 

        if (!await check_timestamp(data.created, data.prev_id, socket)){
            socket_error(data, socket, "Invalid creation time");
            return false;
        }
    
        if(!await validate_previd(data.previd, socket)) {  //recursively check previd
            socket_error(data, socket, "Some previous blocks are invalid");
            return false;
        }
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
            return false;
        }
    }
    // update chain tip if all checks pass
    await update_chain_tip(data, blockid);
    return true;

}

function valid_pow(block: any, blockid:string, socket: any) {
    let blockid_num = parseInt(blockid, 16);
    let target_num = parseInt(block.T, 16);
    if (blockid_num >= target_num){
        socket_error(block, socket, "Block does not meet proof of work requirements.");
        return false;
    }
    return true;
}

async function validate_txids(block:any, socket:any) {
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
    let coinbase = null;
    let coinbase_id = null;
    //check if first is a coinbase
    for (let i=0; i<block.txids.length; i++){
        let txid = block.txids[i];
        let tx = JSON.parse(await get_object(txid));
        console.log("executing " + i)
        // this coinbase should be the first
        if ((!tx.hasOwnProperty("inputs")) && (tx.hasOwnProperty("height"))){
            console.log("entered")
            // if coinbase is not the first
            if (i != 0){
                socket_error(block, socket, "Coinbase transaction is not the first transaction in the block.");
                return false;
            }
            // coinbase is the first -> validate
            if (!validate_coinbase(tx, socket)) return false;
            if (tx.height != await get_block_height(block.prev_id)) {
                socket_error(block, socket, "Incorrect coinbase height");
                return false;
            }
            if (!await validate_coinbase_conservation(block, tx, socket)) return false;
            coinbase = tx;
            coinbase_id = txid;
        }
        // check all other tx does not spend from coinbase
        // TODO: this is not tested!
        if (coinbase != null && txid != coinbase_id){
            for (let txin of tx.inputs){
                if (txin.outpoint.txid == coinbase_id){
                    socket_error(block, socket, "Block contains transaction that spends from coinbase.");
                    return false;
                }
            }
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
                max += prev_output.value;
            }
            for (let output of tx.outputs){
                max -= output.value;
            }
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

async function validate_previd(prev_id: string, socket: any){
    if(await has_object(prev_id)){
        return true
    }

    send_getobject(prev_id, socket);
    checking_previd.add(prev_id);

    var valid = false;
    let start = Date.now()
    while(Date.now() - start < 60000 && checking_previd.has(prev_id)){
        valid = await has_object(prev_id);
        if(valid) {
            checking_previd.delete(prev_id);
            break;
        }
    }

    if(Date.now() - start >= 60000 && checking_previd.has(prev_id)){ //if the message is never sent
        checking_previd.delete(prev_id);
    }

    return valid;
}

async function get_block_height(prev_id: string){
    var previous = 1
    while(true){
        let prev_block = JSON.parse(await get_object(prev_id));
        if(prev_block.prev_id == null){ //genesis
            return previous
        }
        if(prev_block.txids.length > 0){
            let tx = JSON.parse(await get_object(prev_block.txids[0]));
            if(tx.hasOwnProperty("height")){
                return previous + tx.height
            }
        }
        prev_id = prev_block.prev_id
        previous++;
    }
}

async function check_timestamp(created: number, prev_id: string, socket:any){
    var currentTime = + new Date();
    let prev_block = JSON.parse(await get_object(prev_id));

    socket.write(JSON.stringify(created));

    console.log(prev_block.created)
    socket.write(JSON.stringify(prev_block.created));
    socket.write(JSON.stringify(created > prev_block.created)); // TODO: delete
    socket.write(JSON.stringify(created < currentTime));
    return (created > prev_block.created && created < currentTime);
}
async function update_chain_tip(block: any, blockid:any) {
    // if height is larger than previous, then it's a new chaintip!
    let block_height = await get_block_height(block.previd);
    if (block_height > max_height){
        max_height = block_height;
        chain_tip = blockid;
        console.log("New chain tip to update: " + blockid);
    }
}

export function send_chaintip(socket: any) {
    socket.write(send_format({
            type: "chaintip",
            blockid: chain_tip,
        })
    )
}

export async function receive_chaintip(blockid:any, socket:any){
    // if chaintip is not the same as the current chain tip, then update
    if (blockid != chain_tip){
        await has_object(blockid).then(async (val) => {
            if (<any>val){
                // if we have object, then check if chain tip is up to date
                await get_object(blockid).then(async (result) => {
                    let block = JSON.parse(result);
                    await update_chain_tip(block, blockid);
                });
            } else {
                // if we don't have object, then send getobject and validate
                send_getobject(blockid, socket);
            }
        });
    }
}


let tx101 = {"object":{"height":1,"outputs":[{"pubkey":"2564e783d664c41cee6cd044f53eb7a79f09866a7c66d47e1ac0747431e8ea7d","value":50000000000000}],"type":"transaction"},"type":"object"}
      
        // let x = validate_block(JSON.parse(), null);
console.log(hash_string(canonicalize(tx101.object)));

// console.log(x);
