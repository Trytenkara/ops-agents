import pg from 'pg'
import fs from 'fs'
const env = Object.fromEntries(fs.readFileSync('/workspace/.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim().replace(/^["']|["']$/g,'')]))
const url = new URL(env.TENKARA_READONLY_DATABASE_URL)
url.searchParams.set('statement_timeout','30000')
const c = new pg.Client({connectionString:url.toString(), ssl:{rejectUnauthorized:false}})
await c.connect()
const sql = process.argv[2] ?? fs.readFileSync(process.argv[3],'utf8')
const r = await c.query(sql)
console.log(JSON.stringify(r.rows,null,1))
await c.end()
