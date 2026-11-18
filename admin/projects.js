// Every project this admin panel manages. To add one: write adapters/<key>.js (copy stampwise.js) and add a line here.
// A project whose database env var is not set is hidden, so this file can list projects that are not deployed yet.
module.exports={
  stampwise:{name:'Stampwise',url:'https://loyalty.bunkwise.in',db:'STAMPWISE_DATABASE_URL',adapter:require('./adapters/stampwise')},
};
