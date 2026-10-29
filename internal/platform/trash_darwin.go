//go:build darwin

package platform

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Foundation
#import <Foundation/Foundation.h>
#include <stdlib.h>
#include <string.h>

// Returns NULL on success, otherwise a malloc'ed error message.
static char* argusTrash(const char* path) {
	@autoreleasepool {
		NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
		NSError *err = nil;
		BOOL ok = [[NSFileManager defaultManager] trashItemAtURL:url resultingItemURL:nil error:&err];
		if (ok) {
			return NULL;
		}
		const char *msg = err ? [[err localizedDescription] UTF8String] : "unknown error";
		return strdup(msg ? msg : "unknown error");
	}
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

func moveToTrash(path string) error {
	cs := C.CString(path)
	defer C.free(unsafe.Pointer(cs))
	if msg := C.argusTrash(cs); msg != nil {
		defer C.free(unsafe.Pointer(msg))
		return errors.New(C.GoString(msg))
	}
	return nil
}
