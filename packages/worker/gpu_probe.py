# Derived from Starport Pi (MIT), Copyright (c) 2026 Starport contributors.
# Maintained here as the standalone Starport Next worker. See THIRD_PARTY.md.
"""Small CUDA driver smoke test; no framework installation or device identifiers."""
import ctypes as C
import json
cuda=C.CDLL('libcuda.so.1')
def check(name,*args):
    result=getattr(cuda,name)(*args)
    if result:raise RuntimeError(name+'_failed_'+str(result))
check('cuInit',0)
count=C.c_int();check('cuDeviceGetCount',C.byref(count))
device=C.c_int();check('cuDeviceGet',C.byref(device),0)
context=C.c_void_p();check('cuCtxCreate_v2',C.byref(context),0,device)
pointer=C.c_uint64();n=1024
try:
    check('cuMemAlloc_v2',C.byref(pointer),C.c_size_t(n*4))
    check('cuMemsetD32_v2',pointer,17,C.c_size_t(n))
    output=(C.c_uint32*n)();check('cuMemcpyDtoH_v2',output,pointer,C.c_size_t(n*4))
    check('cuCtxSynchronize')
    assert all(v==17 for v in output)
    print(json.dumps({'cuda_available':True,'visible_gpus':count.value,'memory_roundtrip_passed':True}))
finally:
    if pointer.value:check('cuMemFree_v2',pointer)
    check('cuCtxDestroy_v2',context)
