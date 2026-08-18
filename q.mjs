import pg from 'pg'
import fs from 'fs'
const env = Object.fromEntries(fs.readFileSync('/workspace/.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim().replace(/^["']|["']$/g,'')]))
const c = new pg.Client({host:'aws-1-us-west-2.pooler.supabase.com',port:5432,user:'postgres.aiyzpjnvenfmurhyamge',password:env.OA_SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}})
await c.connect()
console.log(JSON.stringify((await c.query(process.argv[2])).rows,null,1))
await c.end()
