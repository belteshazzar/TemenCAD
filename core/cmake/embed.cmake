# Turns a file into a C byte array header: cmake -DIN=... -DOUT=... -DNAME=... -P embed.cmake
file(READ ${IN} HEX_CONTENT HEX)
string(LENGTH "${HEX_CONTENT}" HEX_LEN)
math(EXPR BYTE_LEN "${HEX_LEN} / 2")
string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," BYTES "${HEX_CONTENT}")
# wrap lines so the header stays readable
string(REGEX REPLACE "(0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],)" "\\1\n" BYTES "${BYTES}")
get_filename_component(OUT_DIR ${OUT} DIRECTORY)
file(MAKE_DIRECTORY ${OUT_DIR})
file(WRITE ${OUT} "/* generated from ${IN}; do not edit */\n#include <stddef.h>\nstatic const unsigned char ${NAME}[] = {\n${BYTES}\n};\nstatic const size_t ${NAME}_len = ${BYTE_LEN};\n")
