import { defineConfig } from 'vite';
export default defineConfig({root:'web',base:'./',build:{outDir:'../build',emptyOutDir:true},server:{host:'0.0.0.0',port:5173}});
