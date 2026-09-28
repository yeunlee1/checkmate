// 한국어와 영어 표시 선택을 저장하고 화면의 언어 전환을 알린다.
import { useSyncExternalStore } from 'react';

export type Language = 'ko' | 'en';
const storageKey = 'checkmate.language';
const listeners = new Set<() => void>();
function readLanguage(): Language {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(storageKey) === 'en' ? 'en' : 'ko'; }
  catch { return 'ko'; }
}
let language: Language = readLanguage();
export function getLanguage(): Language { return language; }
export function text(korean: string, english: string): string { return language === 'ko' ? korean : english; }
export function setLanguage(value: Language): void {
  if (value !== 'ko' && value !== 'en') return;
  language = value;
  try { localStorage.setItem(storageKey, value); } catch { /* 저장할 수 없어도 현재 화면의 언어는 바꾼다. */ }
  if (typeof document !== 'undefined') document.documentElement.lang = value;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useLanguage() {
  const current = useSyncExternalStore(subscribe, getLanguage, () => 'ko' as const);
  return { language: current, setLanguage, text };
}
if (typeof document !== 'undefined') document.documentElement.lang = language;
