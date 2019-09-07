const googleDriveCtrl = async (ctx) => {
  const id = ctx.query.id
  const host = 'https://drive.google.com/'
  const newHeaders = {
    'user-agent':ctx.req.headers.get('user-agent')
  }
  let result = { id }
  if( ctx.params.output == 'json' ){
    let resp = await request.get(`${host}file/d/${id}/view`)
    result.name = (resp.body.match(/<meta\s+property="og:title"\s+content="([^"]+)"/) || ['',''])[1]
    result.ext = (result.name.match(/\.([0-9a-z]+)$/) || ['',''])[1]
    if(resp.body.indexOf('errorMessage') >=0 ) return
  }
  
  let downloadUrl
  let { body , headers , redirected , url }= await request.get(`${host}uc?id=${id}&export=download`,{headers: newHeaders , redirect:'manual'})
  if(headers['location']){
    downloadUrl = headers['location']
  }
  //大文件下载提示
  else{
    if(body.indexOf('Too many users') == -1){
      let url = (body.match(/uc\?export=download[^"']+/i) || [''])[0]
      let cookie = headers['set-cookie']
      let resp = await request.get(host + url.replace(/&amp;/g,'&') , {headers:{...newHeaders, cookie} , redirect:'manual'})
      if(resp.headers['location'] ){
        downloadUrl = resp.headers['location']
      }
    }
  }
  result.url = downloadUrl.replace('?e=download','')
  return result
}

/*
 * 辅助 fetch
 */
const request = {
  async get(url , options = {}){
    let mergeOptions = {
      ...options,
      method:'GET',
      headers:Object.assign( {} , options.headers || {} )
    }
    if( mergeOptions.headers['cookie'] ){
      mergeOptions.redentials = 'include'
    }
    if( mergeOptions.body ){
      mergeOptions.body = JSON.stringify(mergeOptions.body);
    }
    if( mergeOptions.json ){
      mergeOptions.headers['Accept'] = 'application/json'
    }

    let response = await fetch(url , mergeOptions)
    if(mergeOptions.raw === true){
      return response
    }
    let resp = { ...response , headers:{} }
    if(response.headers){
      let headers = {}
      for(let i of response.headers.keys()){
        headers[i] = response.headers.get(i)
      }
      resp.headers = headers
    }
    if( mergeOptions.json === true ){
      resp.body = await response.json()
    }else{
      resp.body = await response.text()
    }
    return resp
  }
}

const utils = {
  isPlainObject(obj){
    if (typeof obj !== 'object' || obj === null) return false

    let proto = obj
    while (Object.getPrototypeOf(proto) !== null) {
      proto = Object.getPrototypeOf(proto)
    }
    return Object.getPrototypeOf(obj) === proto
  },
  isType(v, type){
    return Object.prototype.toString.call( v ) === `[object ${type}]`
  }
}

/*
 * 迷你框架 ctx
 */
class Context {
  constructor(event){
    let req = new URL(event.request.url)
    let { pathname } = req
    let query = {} , params = {} , method = event.request.method
    
    for(var pair of req.searchParams.entries()) {
      params[pair[0]] = pair[1]
    }

    this.event = event
    this.query = query
    this.params = params
    this.pathname = pathname
    this.method = method
    this._headers = {
      'Content-Type':'text/html; charset=utf-8'
    }
    this._status = 200
    this._data = null
  }
  set(key , value){
    this._headers[key] = value
  }
  get headers(){
    return this.event.headers
  }
  get res(){
    return this.event.respondWith
  }
  get req(){
    return this.event.request
  }
  set status(code){
    this._status = code
  }
  get data(){
    return this._data
  }
  set body(data){
    // parameter 1 of respondWith is type 'Promise'
    if( utils.isType(data , 'Promise')){
      this._data = data
      return
    }
    if(utils.isPlainObject(data)){
      data = JSON.stringify(data)
      this.set('Content-Type',"application/json")
    }
    this._data = new Response(data , {status:this._status,headers:this._headers})
  }
  redirect(url,code = 302){
    this._data = Response.redirect(url , code)
  }
}

/*
 * 迷你框架，内置路由中间件
 */
class App {
  constructor(){
    this.routes = []
    this.middlewares = []
  }
  use(module){
    this.middlewares.push( module )
  }
  listen(){
    addEventListener('fetch', event => {
      let ctx = new Context(event)
      event.respondWith(this.process(ctx))
    })
  }
  async process(ctx){
    await this.compose([].concat(this.middlewares , this._routerMiddleware.bind(this)))(ctx);
    return ctx.data
  }
  router(method , expr , handler){
    this.routes.push( { ...this._routeToReg(expr) , method:method.toUpperCase() , handler} )
  }
  async _routerMiddleware(ctx , next){
    let query = {} , handler
    let { pathname , method } = ctx
    for(let route of this.routes){
      if( route.method == method ){
        let hit = route.expr.exec( pathname )
        if( hit ){
          hit = hit.slice(1)
          route.key.forEach((i , idx) => {
            query[i] = hit[idx]
          })
          handler = route.handler
          break;
        }
      }
    }
    ctx.query = query
    if(handler) await handler(ctx)
    return next()
  }
  _routeToReg(route){
    let optionalParam = /\((.*?)\)/g ,
        namedParam    = /(\(\?)?:\w+/g,
        splatParam    = /\*\w+/g,
        escapeRegExp  = /[\-{}\[\]+?.,\\\^$|#\s]/g;
    let route_new = route.replace(escapeRegExp, '\\$&')
        .replace(optionalParam, '(?:$1)?')
        .replace(namedParam, function(match, optional) {
            return optional ? match : '([^/?]+)';
        })
        .replace(splatParam, '([^?]*?)');
    let expr = new RegExp('^' + route_new + '(?:\\?([\\s\\S]*))?$');
    let res = expr.exec(route).slice(1)
    res.pop()
    return { expr , key: res.map( i => i.replace(/^\:/,''))};
  }
  compose(middlewares) {
    return (context) => middlewares.reduceRight( (a, b) => () => Promise.resolve(b(context,a)), () => {})(context)
  }
} 

/*
 * 视图中间件，仅用于此项目
 */
const View = (options) => {
  return (ctx , next) => {
    if( ctx.render ) return next()
    ctx.render = async (data) => {
      let type = ctx.params.output
      if( !data ){
        if( type == 'json'){
          ctx.body = {status : -1 , message : "error"}
        }else{
          ctx.body = "404"
        }
      }else{
        if(type == 'json'){
          ctx.body = {status : 0, result:data}
        }
        else if(type == 'redirect'){
          ctx.redirect( data.url )
        }
        else{
          ctx.body = fetch(data.url)
        }
      }
    }
    return next()
  }
}

const app = new App()
app.use( View() )
app.router('get','/gd/:id' , async (ctx) => {
  ctx.render( await googleDriveCtrl(ctx) )
})
app.router('get','/' , async (ctx) => {
  ctx.body = `<!DOCTYPE html><html><head><meta http-equiv="Content-Type"content="text/html; charset=utf-8"><title>LINK</title><style>body{font-family:-apple-system,BlinkMacSystemFont,Helvetica Neue,Helvetica,Roboto,Arial,PingFang SC,Hiragino Sans GB,Microsoft Yahei,Microsoft Jhenghei,sans-serif}</style><style>section{width:650px;background:0 0;position:absolute;top:35%;transform:translate(-50%,-50%);left:50%;color:rgba(0,0,0,.85);font-size:14px;text-align:center}input{box-sizing:border-box;height:48px;width:100%;padding:11px 16px;font-size:16px;color:#404040;background-color:#fff;border:2px solid#ddd;transition:border-color ease-in-out.15s,box-shadow ease-in-out.15s;margin-bottom:24px}button{position:relative;display:inline-block;font-weight:400;white-space:nowrap;text-align:center;box-shadow:0 2px 0 rgba(0,0,0,.015);cursor:pointer;transition:all.3s cubic-bezier(.645,.045,.355,1);user-select:none;border-radius:4px;line-height:1em;background-color:#f2f2f2;border:1px solid#f2f2f2;width:100px;color:#5F6368;font-size:15px;padding:12px;margin:0 6px;outline:none}button:hover{border:1px solid#c6c6c6;background-color:#f8f8f8}h4{font-size:24px;margin-bottom:48px;text-align:center;color:rgba(0,0,0,.7);font-weight:400}</style></head><body><section><h4>直链下载</h4><input value=""id="q"name="q"type="text"placeholder="GoogleDrive 文件ID"/><button onClick="handleDownload()">下载</button><button onClick="handleDownload('json')">JSON</button></section><script>function handleDownload(output){var id=document.querySelector('#q').value;if(id)window.open('/gd/'+id+(output?'?output='+output:''))}</script></body></html>`
})
app.listen()