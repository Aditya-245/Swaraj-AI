'use strict';

// Model routing: pure-local registry, keyword-based task classification.
// No network. Unavailable models fail gracefully with a structured error.

const DEFAULT_REGISTRY = {
  general: { model: 'llama3.2:1b', capabilities: ['text', 'reasoning'] },
  coding: { model: 'qwen2.5-coder:1.5b', capabilities: ['text', 'code'] },
  vision: { model: 'moondream', capabilities: ['text', 'vision'] },
  document: { model: 'llama3.2:1b', capabilities: ['text', 'long-context'] },
};

const ROUTE_PATTERNS = [
  [/write .*code|debug|refactor|python|javascript|typescript|function|class /i, 'coding'],
  [/\.(png|jpg|jpeg|bmp|tiff)|image|photo|drawing|scan|ocr|vision|diagram/i, 'vision'],
  [/summariz|extract|contract|sop|manual|report|invoice|pdf|docx|document/i, 'document'],
];

class ModelRouter {
  constructor(registry = DEFAULT_REGISTRY, available = null) {
    this.registry = registry;
    // available: Set of model names that are actually installed locally.
    // null = assume all registry models available.
    this.available = available ? new Set(available) : null;
  }

  classify(task) {
    const text = typeof task === 'string' ? task : (task.prompt || task.text || '');
    for (const [re, route] of ROUTE_PATTERNS) {
      if (re.test(text)) return route;
    }
    if (task && task.modality === 'image') return 'vision';
    if (task && task.language && task.kind === 'code') return 'coding';
    return 'general';
  }

  route(task) {
    const route = typeof task === 'string' ? this.classify(task) : (task.route || this.classify(task));
    const entry = this.registry[route];
    if (!entry) {
      return { ok: false, route, error: `unknown route: ${route}` };
    }
    if (this.available && !this.available.has(entry.model)) {
      return {
        ok: false, route, model: entry.model,
        error: `model not available locally: ${entry.model}`,
      };
    }
    return { ok: true, route, model: entry.model, capabilities: entry.capabilities };
  }
}

module.exports = { ModelRouter, DEFAULT_REGISTRY };
