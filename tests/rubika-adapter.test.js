import test from 'node:test';
import assert from 'node:assert/strict';
import {Rubika,normalizeRubikaUpdate,rubikaKeyboard} from '../supabase/functions/gptyar-bale/rubika.js';
import {baleBridgeLink,verifyBaleBridgePayment} from '../supabase/functions/gptyar-bale/rubika-payment.js';

const incoming={update:{type:'NewMessage',chat_id:'u123456',new_message:{
 sender_id:'u123456',sender_type:'User',message_id:'789001',text:'/start',
 is_edited:false,aux_data:{button_id:null}
}}};
test('Rubika private text normalizes into a namespaced event without changing Bale IDs',()=>{
 assert.deepEqual(normalizeRubikaUpdate(incoming),{
  channel:'rubika',userId:'u123456',chatId:'u123456',messageId:'789001',
  text:'/start',eventId:'rubika:u123456:789001'
 });
});
test('Rubika rejects groups, forwards acting as other people, and edited events',()=>{
 assert.equal(normalizeRubikaUpdate({update:{...incoming.update,chat_id:'c123456'}}),null);
 assert.equal(normalizeRubikaUpdate({update:{...incoming.update,new_message:{...incoming.update.new_message,is_edited:true}}}),null);
 assert.equal(normalizeRubikaUpdate({inline_message:{chat_id:'u123456',sender_id:'u999999',message_id:'333',text:'خرید اشتراک'}}),null);
});
test('Rubika keypad buttons round trip to Persian menu actions',()=>{
 const k=rubikaKeyboard([['خرید اشتراک','تمدید با توکن'],['لغو']]);
 const button=k.rows[0].buttons[0];
 assert.equal(button.button_text,'خرید اشتراک');
 const event={update:{...incoming.update,new_message:{...incoming.update.new_message,aux_data:{button_id:button.id},text:''}}};
 assert.equal(normalizeRubikaUpdate(event).text,'خرید اشتراک');
 assert.equal(k.resize_keyboard,true);
});
test('Rubika sendMessage obeys v3 method and keyboard contract, without leaking a Bale numeric ID',async()=>{
 const calls=[];
 const transport=async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify({status:'OK',data:{message_id:'msg1'}}),{status:200});
 };
 const client=new Rubika('rubika-test-token-12345678',transport);
 const result=await client.send('u123456','سلام',[['بله','خیر']]);
 assert.equal(result.message_id,'msg1');
 assert.equal(calls.length,1);
 assert.match(calls[0].url,/botapi\.rubika\.ir\/v3\/rubika-test-token-12345678\/sendMessage$/);
 const body=JSON.parse(calls[0].options.body);
 assert.equal(body.chat_id,'u123456');
 assert.equal(body.chat_keypad.rows[0].buttons[0].button_text,'بله');
});
test('Rubika rejects silently unsuccessful send replies',async()=>{
 const client=new Rubika('rubika-test-token-12345678',async()=>new Response(JSON.stringify({status:'ERROR',data:null}),{status:200}));
 await assert.rejects(()=>client.send('u123456','سلام'),{code:'RUBIKA_API_ERROR'});
});
test('Bale payment entry is a Bale bot deep link, not a fictional invoice URL',()=>{
 const token='a'.repeat(64);
 assert.equal(baleBridgeLink('gptyarbot',token),`https://ble.ir/gptyarbot?start=rb_${token}`);
 assert.throws(()=>baleBridgeLink('gptyarbot','weak'),{code:'BRIDGE_NONCE'});
});
test('Rubika delivery requires same order, claimed Bale payer, verified charge and amount',()=>{
 const order={id:'order-1',total_toman:35000};
 const binding={order_id:'order-1',state:'claimed',bale_user_id:123};
 const success={invoice_payload:'order-1',currency:'IRR',total_amount:350000,telegram_payment_charge_id:'charge-1'};
 const transaction={id:'charge-1',status:'paid',userID:123,amount:350000};
 const args={order,binding,success,transaction,payerId:123};
 assert.equal(verifyBaleBridgePayment(args).chargeId,'charge-1');
 assert.throws(()=>verifyBaleBridgePayment({...args,payerId:456}),{code:'PAYMENT_MISMATCH'});
 assert.throws(()=>verifyBaleBridgePayment({...args,transaction:{...transaction,status:'pending'}}),{code:'PAYMENT_NOT_VERIFIED'});
 assert.throws(()=>verifyBaleBridgePayment({...args,success:{...success,total_amount:100}}),{code:'PAYMENT_MISMATCH'});
 assert.throws(()=>verifyBaleBridgePayment({...args,binding:{...binding,state:'unclaimed'}}),{code:'PAYMENT_MISMATCH'});
});
