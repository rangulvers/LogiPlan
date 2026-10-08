import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyCommand, isTypingTarget, dialogOpen } from '../js/ui/editor/keys.js';
import {
  TOOL_NAMES, TOOL_KEYS, plannerName, obstacleName, nextObstacleKind, nextSpeedFactor, toolCursor, toolHint,
  newStationName, flowProblem, isStationTool, isStrokeTool,
} from '../js/ui/editor/tools.js';
import { STATION_TYPES } from '../js/model/defaults.js';
import { layoutFromAscii } from './helpers/ascii.js';

const key = (k, mods = {}) => keyCommand({ key: k, ...mods });

test('keyCommand: the tool shortcuts of the spec', () => {
  const expected = { v: 'select', h: 'pan', r: 'road', o: 'oneway', z: 'speedzone', e: 'erase', 1: 'source', 2: 'process', 3: 'storage', 4: 'sink', 5: 'depot', w: 'obstacle', t: 'label', f: 'flow' };
  for (const [k, tool] of Object.entries(expected)) assert.deepEqual(key(k), { cmd: 'tool', tool }, k);
  assert.deepEqual(key('V'), { cmd: 'tool', tool: 'select' }, 'caps lock / shift does not matter');
  assert.deepEqual(TOOL_KEYS, expected);
  assert.equal(new Set(Object.values(TOOL_KEYS)).size, 14);
  for (const tool of Object.values(TOOL_KEYS)) assert.ok(TOOL_NAMES.includes(tool));
});

test('keyCommand: undo, redo, duplicate, select all', () => {
  assert.deepEqual(key('z', { ctrlKey: true }), { cmd: 'undo' });
  assert.deepEqual(key('z', { metaKey: true }), { cmd: 'undo' });
  assert.deepEqual(key('Z', { ctrlKey: true, shiftKey: true }), { cmd: 'redo' });
  assert.deepEqual(key('z', { metaKey: true, shiftKey: true }), { cmd: 'redo' });
  assert.deepEqual(key('y', { ctrlKey: true }), { cmd: 'redo' });
  assert.deepEqual(key('d', { ctrlKey: true }), { cmd: 'duplicate' });
  assert.deepEqual(key('a', { metaKey: true }), { cmd: 'selectAll' });
});

test('keyCommand: browser shortcuts are never ours', () => {
  for (const k of ['r', 'w', 't', 'f', 'l', 'p', 's', 'c', 'v', 'x', 'n', 'h', 'e', 'o', '1', '2', '+', '-', '0', 'F5', 'Tab']) {
    assert.equal(key(k, { ctrlKey: true }), null, `Ctrl+${k}`);
    assert.equal(key(k, { metaKey: true }), null, `Cmd+${k}`);
  }
  assert.equal(key('r', { altKey: true }), null, 'Alt combinations are left to the browser and the OS');
  assert.equal(key('ArrowLeft', { altKey: true }), null, 'Alt+Left is "back"');
  assert.equal(key('d', { ctrlKey: true, shiftKey: true }), null);
  assert.equal(key('y', { ctrlKey: true, shiftKey: true }), null);
});

test('keyCommand: Delete, Backspace, Escape and the arrow keys (5 cells with Shift)', () => {
  assert.deepEqual(key('Delete'), { cmd: 'delete' });
  assert.deepEqual(key('Backspace'), { cmd: 'delete' });
  assert.deepEqual(key('Escape'), { cmd: 'escape' });
  assert.deepEqual(key('ArrowLeft'), { cmd: 'nudge', dx: -1, dy: 0 });
  assert.deepEqual(key('ArrowRight'), { cmd: 'nudge', dx: 1, dy: 0 });
  assert.deepEqual(key('ArrowUp'), { cmd: 'nudge', dx: 0, dy: -1 });
  assert.deepEqual(key('ArrowDown', { shiftKey: true }), { cmd: 'nudge', dx: 0, dy: 5 });
  assert.deepEqual(key('ArrowLeft', { shiftKey: true }), { cmd: 'nudge', dx: -5, dy: 0 });
});

test('keyCommand: other keys do nothing (Space is handled by the editor as a pan modifier)', () => {
  for (const k of [' ', 'Enter', 'Shift', 'q', '6', '0', 'Tab']) assert.equal(key(k), null, JSON.stringify(k));
});

test('isTypingTarget: inputs, textareas, selects and contenteditable', () => {
  assert.ok(isTypingTarget({ tagName: 'INPUT' }));
  assert.ok(isTypingTarget({ tagName: 'TEXTAREA' }));
  assert.ok(isTypingTarget({ tagName: 'SELECT' }));
  assert.ok(isTypingTarget({ tagName: 'DIV', isContentEditable: true }));
  assert.ok(!isTypingTarget({ tagName: 'BUTTON' }));
  assert.ok(!isTypingTarget({ tagName: 'BODY' }));
  assert.ok(!isTypingTarget(null));
  assert.ok(!isTypingTarget(undefined));
});

test('dialogOpen: true while a [role=dialog] exists', () => {
  assert.equal(dialogOpen({ querySelector: (sel) => (sel === '[role="dialog"]' ? {} : null) }), true);
  assert.equal(dialogOpen({ querySelector: () => null }), false);
  assert.equal(dialogOpen(null), false);
});

test('tools: names, planner language and predicates', () => {
  assert.equal(TOOL_NAMES.length, 14);
  assert.deepEqual(TOOL_NAMES.slice(0, 2), ['select', 'pan']);
  assert.equal(plannerName('source'), 'Goods in');
  assert.equal(plannerName('process'), 'Workstation');
  assert.equal(plannerName('sink'), 'Goods out');
  assert.equal(plannerName('depot'), 'Parking & charging');
  assert.equal(obstacleName('rack'), 'Rack');
  assert.equal(obstacleName('nonsense'), 'Wall');
  assert.ok(isStationTool('depot') && !isStationTool('road') && !isStationTool('obstacle'));
  assert.ok(isStrokeTool('erase') && isStrokeTool('speedzone') && !isStrokeTool('flow'));
});

test('tools: the Z and W keys cycle their options', () => {
  assert.equal(nextObstacleKind('wall'), 'rack');
  assert.equal(nextObstacleKind('rack'), 'column');
  assert.equal(nextObstacleKind('column'), 'wall');
  assert.equal(nextSpeedFactor(0.5), 0.25);
  assert.equal(nextSpeedFactor(0.25), 0.75);
  assert.equal(nextSpeedFactor(0.75), 0.5);
  assert.equal(nextSpeedFactor(0.9), 0.5, 'an unknown value restarts the cycle');
});

test('tools: every tool has a cursor and a hint; hints use planner language and the options', () => {
  for (const tool of TOOL_NAMES) {
    assert.ok(toolCursor(tool), tool);
    assert.ok(toolHint(tool, { factor: 0.5, kind: 'wall' }).length > 10, tool);
  }
  assert.equal(toolCursor('select'), 'default');
  assert.equal(toolCursor('pan'), 'grab');
  assert.equal(toolCursor('label'), 'text');
  assert.match(toolHint('road'), /two-way road.*Shift = straight line/);
  assert.match(toolHint('speedzone', { factor: 0.25 }), /25 %/);
  assert.match(toolHint('obstacle', { kind: 'rack' }), /rack/);
  assert.match(toolHint('process'), /Workstation/);
  assert.match(toolHint('source'), /Goods in/);
  assert.notEqual(toolHint('flow', { pending: true }), toolHint('flow', { pending: false }));
  for (const t of Object.keys(STATION_TYPES)) assert.doesNotMatch(toolHint(t), /\bsource\b|\bsink\b|\bprocess\b/i, `no jargon in the hint of ${t}`);
});

test('newStationName: planner names, numbered to the first free number', () => {
  const layout = layoutFromAscii(['AA..', 'AA..'], { stations: { A: 'process' } });
  layout.stations[0].name = 'Workstation 1';
  assert.equal(newStationName(layout, 'process'), 'Workstation 2');
  assert.equal(newStationName(layout, 'source'), 'Goods in 1');
  assert.equal(newStationName(layout, 'sink'), 'Goods out 1');
  assert.equal(newStationName(layout, 'storage'), 'Storage 1');
  assert.equal(newStationName(layout, 'depot'), 'Parking 1');
  layout.stations[0].name = 'Workstation 2';
  assert.equal(newStationName(layout, 'process'), 'Workstation 1', 'fills the gap');
});

test('flowProblem: which stations may send and receive loads, in plain language', () => {
  const st = (type, id = type) => ({ id, type });
  assert.equal(flowProblem(st('process'), st('storage')), null);
  assert.equal(flowProblem(st('source'), st('sink')), null);
  assert.equal(flowProblem(st('storage'), st('process')), null);
  assert.equal(flowProblem(st('sink'), null), 'Goods out cannot send loads.');
  assert.equal(flowProblem(st('depot'), null), 'Parking & charging cannot send loads.');
  assert.equal(flowProblem(st('source'), st('source', 's2')), 'Goods in cannot receive loads.');
  assert.equal(flowProblem(st('process'), st('depot')), 'Parking & charging cannot receive loads.');
  assert.equal(flowProblem(st('process', 'p'), st('process', 'p')), 'A station cannot send loads to itself.');
  assert.equal(flowProblem(st('process'), null), null, 'a sender alone is fine');
});
