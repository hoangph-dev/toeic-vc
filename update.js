/* Tự cập nhật khi có bản deploy mới. Tiến trình học nằm trong localStorage (cùng origin)
   nên reload trang không làm mất dữ liệu. Trang đã tải được so sánh với bản mới nhất trên server. */
(function(){
 var base=null,last=0,busy=false;
 function hash(t){var x=5381,i;for(i=0;i<t.length;i++)x=((x<<5)+x+t.charCodeAt(i))|0;return x}
 function get(){return fetch(location.pathname+location.search,{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.text()}).then(hash)}
 function check(){
  if(busy||Date.now()-last<20000)return;busy=true;last=Date.now();
  get().then(function(h){
   if(base===null)base=h;
   else if(h!==base){try{window.dispatchEvent(new Event('app-update'))}catch(e){}location.reload()}
  }).catch(function(){}).then(function(){busy=false});
 }
 document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')check()});
 window.addEventListener('pageshow',function(e){if(e.persisted)check()});
 window.addEventListener('online',check);
 check();
 /* xin trình duyệt không tự xóa localStorage khi thiếu dung lượng */
 try{if(navigator.storage&&navigator.storage.persist)navigator.storage.persist()}catch(e){}
})();
