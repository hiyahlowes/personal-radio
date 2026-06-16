import { describe, expect, it } from 'vitest';
import { buildViaPrompt, extractTask } from './via-moderator-service.mjs';

describe('via-moderator-service', () => {
  describe('extractTask', () => {
    it('returns empty string for missing messages', () => {
      expect(extractTask(undefined)).toBe('');
      expect(extractTask([])).toBe('');
    });

    it('extracts text from a string-content user message', () => {
      const msgs = [
        { role: 'user', content: 'Introduce the next song.' },
      ];
      expect(extractTask(msgs)).toBe('Introduce the next song.');
    });

    it('extracts text from an array-content user message', () => {
      const msgs = [
        { role: 'user', content: [{ type: 'text', text: 'Line one.' }, { type: 'text', text: 'Line two.' }] },
      ];
      expect(extractTask(msgs)).toBe('Line one.\nLine two.');
    });

    it('uses the last user message when multiple are present', () => {
      const msgs = [
        { role: 'user', content: 'First.' },
        { role: 'assistant', content: 'Reply.' },
        { role: 'user', content: 'Second.' },
      ];
      expect(extractTask(msgs)).toBe('Second.');
    });
  });

  describe('buildViaPrompt', () => {
    it('frames Via as advisor, not moderator', () => {
      const prompt = buildViaPrompt({
        messages: [{ role: 'user', content: 'Introduce Bitcoin Effekt by Jan.' }],
      });

      expect(prompt).toContain('Du BIST NICHT der Moderator');
      expect(prompt).toContain('Du informierst den Moderator');
    });

    it('includes Thomas context', () => {
      const prompt = buildViaPrompt({
        messages: [{ role: 'user', content: 'Greet the listener.' }],
      });

      expect(prompt).toContain('Thomas Kitsche');
      expect(prompt).toContain('Dorfgeflüster');
      expect(prompt).toContain('persönlicher, aktueller Lebensbezug');
    });

    it('puts the moderator soul before Via instructions', () => {
      const prompt = buildViaPrompt({
        system: 'You are a Bitcoin maxi radio host with warm friend energy.',
        messages: [{ role: 'user', content: 'Introduce Bitcoin Effekt by Jan.' }],
      });

      expect(prompt.indexOf('You are a Bitcoin maxi radio host')).toBeLessThan(prompt.indexOf('VIA-AUFGABE'));
      expect(prompt).toContain('Der Moderator behält seine eigene Persönlichkeit');
    });

    it('includes the task text', () => {
      const task = 'Moderiere den Wechsel von Musik zu Tagesschau.';
      const prompt = buildViaPrompt({
        messages: [{ role: 'user', content: task }],
      });

      expect(prompt).toContain(task);
    });

    it('handles empty messages gracefully', () => {
      const prompt = buildViaPrompt({ messages: [] });
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(50);
    });
  });
});
