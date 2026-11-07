#![no_std]
use core::ffi::{c_char,c_void};
#[panic_handler] fn panic(_: &core::panic::PanicInfo) -> ! { loop {} }
type Env=*mut c_void;type Val=*mut c_void;type Info=*mut c_void;
#[link(name="node")] unsafe extern "C" {
 fn napi_get_cb_info(e:Env,i:Info,n:*mut usize,a:*mut Val,t:*mut Val,d:*mut *mut c_void)->i32;
 fn napi_get_value_string_utf16(e:Env,v:Val,b:*mut u16,l:usize,n:*mut usize)->i32;
 fn napi_get_value_bigint_uint64(e:Env,v:Val,n:*mut u64,lossless:*mut bool)->i32;
 fn napi_get_boolean(e:Env,b:bool,r:*mut Val)->i32;
 fn napi_get_buffer_info(e:Env,v:Val,p:*mut *mut c_void,n:*mut usize)->i32;
 fn napi_create_bigint_uint64(e:Env,n:u64,r:*mut Val)->i32;
 fn napi_create_function(e:Env,n:*const c_char,l:usize,cb:unsafe extern "C" fn(Env,Info)->Val,d:*mut c_void,r:*mut Val)->i32;
 fn napi_set_named_property(e:Env,o:Val,n:*const c_char,v:Val)->i32;
}
#[link(name="kernel32",kind="raw-dylib")] unsafe extern "system" {
 fn CreateFileW(path:*const u16,access:u32,share:u32,security:*mut c_void,creation:u32,flags:u32,template:*mut c_void)->isize;
 fn WriteFile(h:isize,data:*const u8,size:u32,written:*mut u32,overlapped:*mut c_void)->i32;
 fn FlushFileBuffers(h:isize)->i32;fn CloseHandle(h:isize)->i32;
}
// Unregistered candidate; this file is not a production-trusted loader or approval owner.
unsafe extern "C" fn create(e:Env,i:Info)->Val {unsafe{
 let mut n=2usize;let mut args:[Val;2]=[core::ptr::null_mut();2];
 if napi_get_cb_info(e,i,&mut n,args.as_mut_ptr(),core::ptr::null_mut(),core::ptr::null_mut())!=0||n!=2{return core::ptr::null_mut()}
 let mut name=core::mem::MaybeUninit::<[u16;1024]>::uninit();let mut length=0usize;let mut data:*mut c_void=core::ptr::null_mut();let mut data_len=0usize;
 if napi_get_value_string_utf16(e,args[0],name.as_mut_ptr() as *mut u16,1024,&mut length)!=0||length==0||length>=1023||napi_get_buffer_info(e,args[1],&mut data,&mut data_len)!=0||data_len==0||data_len>131072||data.is_null(){return core::ptr::null_mut()}
 let h=CreateFileW(name.as_ptr() as *const u16,0x80000000|0x40000000,1|4,core::ptr::null_mut(),1,0,core::ptr::null_mut());if h == -1{return core::ptr::null_mut()}
 let mut written=0u32;
 if WriteFile(h,data as *const u8,data_len as u32,&mut written,core::ptr::null_mut())==0||written!=data_len as u32||FlushFileBuffers(h)==0 {CloseHandle(h);return core::ptr::null_mut()}
 let mut out=core::ptr::null_mut();if napi_create_bigint_uint64(e,h as u64,&mut out)!=0 {CloseHandle(h);return core::ptr::null_mut()}out
}}
unsafe extern "C" fn close(e:Env,i:Info)->Val {unsafe{
 let mut n=1usize;let mut arg:Val=core::ptr::null_mut();let mut h=0u64;let mut lossless=false;
 if napi_get_cb_info(e,i,&mut n,&mut arg,core::ptr::null_mut(),core::ptr::null_mut())!=0||n!=1||napi_get_value_bigint_uint64(e,arg,&mut h,&mut lossless)!=0||!lossless||h==0{return core::ptr::null_mut()}let ok=CloseHandle(h as isize)!=0;let mut result=core::ptr::null_mut();if napi_get_boolean(e,ok,&mut result)!=0{return core::ptr::null_mut()}result
}}
#[unsafe(no_mangle)] pub unsafe extern "C" fn napi_register_module_v1(e:Env,exports:Val)->Val {unsafe{
 let mut f=core::ptr::null_mut();let name=b"create\0".as_ptr() as *const c_char;
 if napi_create_function(e,name,6,create,core::ptr::null_mut(),&mut f)!=0||napi_set_named_property(e,exports,name,f)!=0{return core::ptr::null_mut()}
 let pname=b"close\0".as_ptr() as *const c_char;if napi_create_function(e,pname,5,close,core::ptr::null_mut(),&mut f)!=0||napi_set_named_property(e,exports,pname,f)!=0{return core::ptr::null_mut()}exports
}}
