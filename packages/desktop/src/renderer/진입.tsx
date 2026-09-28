// 제한된 preload 계약을 사용하는 데스크톱 화면을 시작한다.
import { createRoot } from 'react-dom/client';
import { App } from './앱.js';
import './글꼴.css';
import './화면.css';

const root = document.getElementById('root');
if (!root) throw new Error('화면을 시작할 위치가 없습니다.');
createRoot(root).render(<App />);
