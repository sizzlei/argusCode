//go:build darwin

package platform

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Foundation
#import <Foundation/Foundation.h>
#include <stdlib.h>
#include <string.h>

// Resolves a file reference path (/.file/id=…) to the real path; NULL if it can't.
static char* argusResolveFileRef(const char* ref) {
	@autoreleasepool {
		NSString *s = [@"file://" stringByAppendingString:[NSString stringWithUTF8String:ref]];
		NSURL *url = [NSURL URLWithString:s];
		NSURL *real = [url filePathURL];
		if (real == nil || real.path == nil) {
			return NULL;
		}
		return strdup([real.path fileSystemRepresentation]);
	}
}
*/
import "C"

import "unsafe"

func resolveFileReference(ref string) string {
	cs := C.CString(ref)
	defer C.free(unsafe.Pointer(cs))
	r := C.argusResolveFileRef(cs)
	if r == nil {
		return ""
	}
	defer C.free(unsafe.Pointer(r))
	return C.GoString(r)
}
