import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideHandoff } from '../handoff.ts';
test('invalid destination rejects',()=>{const b:any={resolved:{roster:['worker'],maxRework:0,advisorAfter:null,specs:false,phases:[]},leader:{sessionName:'l'},sessions:{},history:[]};const r=decideHandoff({board:b,from:'worker',to:'qa',phase:'X',liveSessions:[],now:1,handoffId:'h'});assert.equal(r.ok,false);});
test('empty spec does not break board rework counting',()=>{const b:any={resolved:{roster:['worker','qa'],maxRework:2,advisorAfter:null,specs:false,phases:[{name:'QA',owner:'qa'}]},leader:{sessionName:'l'},sessions:{worker:{sessionName:'w',contextEpoch:0}},history:[],specs:{},reworkRound:0,lastAdvisorConsultedRound:null};const r=decideHandoff({board:b,from:'qa',to:'worker',phase:'QA',spec:'',verdict:'FAIL',liveSessions:['w'],now:1,handoffId:'h'});assert.equal(r.ok,true);if(r.ok)assert.equal(r.board.reworkRound,1);});
