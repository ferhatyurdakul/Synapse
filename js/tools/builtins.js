/**
 * Built-in tools: calc, date, convert
 * Each registers itself into the toolRegistry with OpenAI-compatible parameter schemas.
 */

import { toolRegistry } from '../services/toolRegistry.js?v=36';

// ─── Calculator ───────────────────────────────────────────────────────────────

const MATH_FNS = /\b(sqrt|cbrt|abs|round|floor|ceil|sin|cos|tan|asin|acos|atan|atan2|log|log2|log10|exp|max|min|pow|hypot|sign|trunc)\b/g;

function safeCalc(expr) {
    if (!expr) throw new Error('No expression provided.');

    // Strip known function names, then verify only safe chars remain
    const stripped = expr.trim().replace(MATH_FNS, '').replace(/\bPI\b|\bE\b/g, '');
    if (!/^[\d+\-*/.() %\s^,]+$/.test(stripped)) {
        throw new Error('Invalid expression — only numbers and math operators allowed.');
    }

    const prepared = expr.trim()
        .replace(/\^/g, '**')
        .replace(/\bPI\b/g, 'Math.PI')
        .replace(/\bE\b/g, 'Math.E')
        .replace(MATH_FNS, 'Math.$1');

    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + prepared + ')')();

    if (typeof result !== 'number') throw new Error('Expression did not return a number.');
    if (!isFinite(result)) throw new Error(isNaN(result) ? 'Result is NaN.' : 'Result is infinite (division by zero?).');

    const display = Number.isInteger(result)
        ? result.toLocaleString()
        : parseFloat(result.toPrecision(10)).toLocaleString();

    return `${expr.trim()} = **${display}**`;
}

// ─── Date / Time ──────────────────────────────────────────────────────────────

function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 864e5) + 1) / 7);
    return `W${String(week).padStart(2, '0')} ${d.getUTCFullYear()}`;
}

function handleDate(query = '') {
    const now = new Date();
    const dateFmt = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const timeFmt = { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };

    const lines = [
        `**Date:** ${now.toLocaleDateString(undefined, dateFmt)}`,
        `**Time:** ${now.toLocaleTimeString(undefined, timeFmt)}`,
        `**ISO 8601:** ${now.toISOString()}`,
        `**Unix:** ${Math.floor(now / 1000)}`,
        `**Week:** ${isoWeek(now)}`,
    ];

    if (query) {
        const sinceMatch = query.match(/^since\s+(.+)$/i);
        const inMatch    = query.match(/^in\s+(\d+)\s+(day|week|month|year)s?$/i);

        if (sinceMatch) {
            const then = new Date(sinceMatch[1]);
            if (isNaN(then)) throw new Error(`Cannot parse date: "${sinceMatch[1]}"`);
            const days = Math.floor((now - then) / 864e5);
            lines.push(`**Days since ${sinceMatch[1]}:** ${days.toLocaleString()}`);
        } else if (inMatch) {
            const n    = parseInt(inMatch[1]);
            const unit = inMatch[2].toLowerCase();
            const future = new Date(now);
            if (unit === 'day')   future.setDate(future.getDate() + n);
            if (unit === 'week')  future.setDate(future.getDate() + n * 7);
            if (unit === 'month') future.setMonth(future.getMonth() + n);
            if (unit === 'year')  future.setFullYear(future.getFullYear() + n);
            lines.push(`**In ${n} ${unit}(s):** ${future.toLocaleDateString(undefined, dateFmt)}`);
        } else {
            throw new Error('Supported formats: "since YYYY-MM-DD" or "in N days/weeks/months/years"');
        }
    }

    return lines.join('\n');
}

// ─── Unit Converter ───────────────────────────────────────────────────────────

// All values relative to a base unit per group
const CONV = {
    // Length → metres
    mm: 1e-3, cm: 1e-2, m: 1, km: 1e3,
    in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852,
    // Weight → grams
    mg: 1e-3, g: 1, kg: 1e3, t: 1e6,
    oz: 28.3495, lb: 453.592,
    // Volume → millilitres
    ml: 1, cl: 10, dl: 100, l: 1e3,
    tsp: 4.92892, tbsp: 14.7868, 'fl oz': 29.5735,
    cup: 236.588, pt: 473.176, qt: 946.353, gal: 3785.41,
    // Data → bytes
    b: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776,
    // Speed → m/s
    'km/h': 1 / 3.6, mph: 0.44704, knot: 0.514444,
};

const GROUPS = [
    ['mm', 'cm', 'm', 'km', 'in', 'ft', 'yd', 'mi', 'nmi'],
    ['mg', 'g', 'kg', 't', 'oz', 'lb'],
    ['ml', 'cl', 'dl', 'l', 'tsp', 'tbsp', 'fl oz', 'cup', 'pt', 'qt', 'gal'],
    ['b', 'kb', 'mb', 'gb', 'tb'],
    ['km/h', 'mph', 'knot'],
];

function unitGroup(u) {
    return GROUPS.find(g => g.includes(u)) || null;
}

function fmtNum(n) {
    if (!isFinite(n)) return '∞';
    if (Math.abs(n) >= 1e9 || (Math.abs(n) < 1e-4 && n !== 0)) return n.toExponential(4);
    if (Number.isInteger(n)) return n.toLocaleString();
    return parseFloat(n.toPrecision(6)).toLocaleString();
}

// Temperature aliases
const TEMP_NORM = {
    c: 'C', celsius: 'C', '°c': 'C',
    f: 'F', fahrenheit: 'F', '°f': 'F',
    k: 'K', kelvin: 'K', '°k': 'K',
};

function convertTemp(value, from, to) {
    if (from === to) return value;
    const toCelsius = { C: v => v, F: v => (v - 32) * 5 / 9, K: v => v - 273.15 };
    const fromCelsius = { C: v => v, F: v => v * 9 / 5 + 32, K: v => v + 273.15 };
    return fromCelsius[to](toCelsius[from](value));
}

function handleConvert(value, from, to) {
    if (value === undefined || !from || !to) throw new Error('Required: value, from, to');

    const fromRaw = String(from).trim().toLowerCase();
    const toRaw   = String(to).trim().toLowerCase();
    const numVal  = Number(value);

    if (isNaN(numVal)) throw new Error(`"${value}" is not a valid number.`);

    // Temperature
    const fromTemp = TEMP_NORM[fromRaw];
    const toTemp   = TEMP_NORM[toRaw];
    if (fromTemp && toTemp) {
        const result = convertTemp(numVal, fromTemp, toTemp);
        return `${numVal}°${fromTemp} = **${fmtNum(result)}°${toTemp}**`;
    }

    if (!(fromRaw in CONV)) throw new Error(`Unknown unit: "${fromRaw}".`);
    if (!(toRaw in CONV))   throw new Error(`Unknown unit: "${toRaw}".`);

    const fromGroup = unitGroup(fromRaw);
    const toGroup   = unitGroup(toRaw);
    if (!fromGroup || fromGroup !== toGroup) {
        throw new Error(`"${fromRaw}" and "${toRaw}" are different unit types and cannot be converted.`);
    }

    const result = (numVal * CONV[fromRaw]) / CONV[toRaw];
    return `${numVal} ${fromRaw} = **${fmtNum(result)} ${toRaw}**`;
}

// ─── Register ─────────────────────────────────────────────────────────────────

toolRegistry.register({
    name: 'calc',
    description: 'Evaluate a mathematical expression and return the result',
    parameters: {
        type: 'object',
        properties: {
            expression: {
                type: 'string',
                description: 'The math expression to evaluate, e.g. "2 + 2", "sqrt(144)", "PI * 5^2"'
            }
        },
        required: ['expression']
    },
    handler: ({ expression }) => safeCalc(expression)
});

toolRegistry.register({
    name: 'date',
    description: 'Get the current date and time, or perform date arithmetic',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Optional date query: "since YYYY-MM-DD" to get days elapsed, or "in N days/weeks/months/years" for a future date. Omit for current date/time.'
            }
        },
        required: []
    },
    handler: ({ query = '' } = {}) => handleDate(query)
});

toolRegistry.register({
    name: 'convert',
    description: 'Convert a value between units (length, weight, volume, data storage, speed, temperature)',
    parameters: {
        type: 'object',
        properties: {
            value: {
                type: 'number',
                description: 'The numeric value to convert'
            },
            from: {
                type: 'string',
                description: 'Source unit, e.g. "kg", "km", "C", "gb", "mph"'
            },
            to: {
                type: 'string',
                description: 'Target unit, e.g. "lb", "mi", "F", "mb", "km/h"'
            }
        },
        required: ['value', 'from', 'to']
    },
    handler: ({ value, from, to }) => handleConvert(value, from, to)
});
