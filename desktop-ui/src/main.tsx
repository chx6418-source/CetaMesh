import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import './theme/tokens.css';
import './theme/global.css';
import { HarborApp } from './app/HarborApp';

const root = document.getElementById('root');
if (!root) throw new Error('CetaMesh UI root is missing');
createRoot(root).render(<React.StrictMode><BrowserRouter><HarborApp /></BrowserRouter></React.StrictMode>);
