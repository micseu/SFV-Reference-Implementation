import { createApp } from './app.mjs';

const server = createApp().listen(Number(process.env.PORT ?? 8080), '127.0.0.1', () => {
  console.log(`SFV browser demo: http://127.0.0.1:${server.address().port}/`);
});
