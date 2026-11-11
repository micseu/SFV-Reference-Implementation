import express from 'express';
import { staticOptions } from '../http.mjs';

/** Serves one directory without caching; used for the page files and the shared src/ modules. */
export function createStaticController(directory) {
  return express.static(directory, staticOptions);
}
