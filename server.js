// Long-running server (local dev, Docker, Render, Railway, a VPS). On Vercel, api/index.js serves the same app instead.
const app=require('./app');
const server=app.listen(process.env.PORT||3000,()=>console.log('Stampwise running on',process.env.PORT||3000));
// hosts send SIGTERM before replacing the app: finish requests, then close DB connections
const stop=()=>{server.close(()=>app.locals.pool.end().finally(()=>process.exit(0)));setTimeout(()=>process.exit(0),1e4).unref()};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
